/**
 * Scheduled-publish processor.
 *
 * Pulls `scheduled_publishes` rows whose effective due time (either
 * `next_retry_at` if set, else `scheduled_at`) has passed and `status =
 * 'pending'`, then dispatches every row through the `publisher` agent
 * with the row's stored `mode` (intent|direct). The agent owns the
 * per-mode logic:
 *   - intent: returns composer URLs per platform
 *   - direct: looks up platform_connections and posts via the OAuth APIs
 *
 * Post-agent: if every platform in direct mode failed, the row is treated
 * as failed (may retry with backoff if the error is transient); if at
 * least one platform succeeded, the row is marked 'complete'.
 *
 * Deps are injected so this module can be unit-tested without a real DB or
 * live platform APIs.
 */

const DEFAULT_INTERVAL_MS = parseInt(process.env.SCHED_PUBLISH_TICK_MS) || 60_000;
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.SCHED_PUBLISH_MAX_ATTEMPTS) || 3;

// Exponential backoff: 2min, 10min, 30min, then cap at 2h for any further
// attempts. Keeps the tight first retry for transient network blips while
// still yielding a sensible ceiling for ratelimit / provider-outage scenarios.
const BACKOFF_SCHEDULE_MINUTES = [2, 10, 30, 120];

function nextRetryDelayMs(attempts) {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_SCHEDULE_MINUTES.length - 1);
  return BACKOFF_SCHEDULE_MINUTES[idx] * 60_000;
}

// Not every failure should be retried. Input-level errors (missing image_url,
// invalid subreddit) won't magically succeed later — we fail them fast.
// Transient signals: 429 ratelimit, 5xx upstream, network timeouts.
function isRetryable(errorMessage) {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  if (/\b(429|5\d\d)\b/.test(msg)) return true;
  if (/timeout|timedout|timed out|econnreset|enotfound|econnrefused|network/i.test(msg)) return true;
  if (/rate[- ]?limit|too many requests/i.test(msg)) return true;
  return false;
}

let timer = null;
let ticking = false;

/**
 * Run one tick of the scheduled-publish processor.
 *
 * @param {object} deps
 * @param {function} deps.query       async (sql, params) => { rows }
 * @param {function} deps.queryOne    async (sql, params) => row | null
 * @param {function} deps.exec        async (sql, params) => { rowCount? }
 * @param {function} deps.uuidv4      () => string
 * @param {object}   deps.agentRuntime   module from ./agent-runtime
 * @param {object}   deps.notifications  module from ./notifications
 * @param {object}  [deps.publishOauth]  legacy dep — no longer used directly,
 *                                       the publisher agent loads it itself.
 * @param {number}  [deps.limit=20]
 */
async function processDue(deps) {
  const { query, queryOne, exec, uuidv4, publishOauth, agentRuntime, notifications } = deps;
  const limit = deps.limit || 20;

  const nowIso = new Date().toISOString();
  // A row is due when its scheduled_at (first run) or next_retry_at (subsequent
  // retries) is in the past. COALESCE keeps the query portable between SQLite
  // and Postgres; the index idx_sched_pub_retry covers (status, next_retry_at).
  const due = await query(
    "SELECT * FROM scheduled_publishes WHERE status = 'pending' AND COALESCE(next_retry_at, scheduled_at) <= ? ORDER BY COALESCE(next_retry_at, scheduled_at) ASC LIMIT ?",
    [nowIso, limit]
  );
  const rows = due.rows || [];
  if (rows.length === 0) return { processed: 0, ok: 0, failed: 0 };

  let ok = 0, failed = 0;
  for (const row of rows) {
    try {
      await exec(
        "UPDATE scheduled_publishes SET status='running', last_attempt_at=CURRENT_TIMESTAMP, attempts=attempts+1 WHERE id=?",
        [row.id]
      );
      const snapshot = JSON.parse(row.content_snapshot);
      const platforms = JSON.parse(row.platforms);
      const content = {
        title: snapshot.title,
        body: snapshot.type === 'image' ? (snapshot.title || '') : (snapshot.body || ''),
        cta: snapshot.metadata?.cta,
        hashtags: snapshot.metadata?.hashtags || [],
        image_url: snapshot.type === 'image' ? snapshot.body : snapshot.metadata?.image_url,
      };

      let finalOutput = null;
      let finalError = null;

      // Both 'direct' and 'intent' modes now flow through the publisher agent
      // — the agent looks up platform_connections for direct mode and builds
      // composer URLs for intent mode. This collapses the two dispatch paths
      // into one code path so Conductor, metering, and RBAC only have to
      // think about one agent.
      {
        const { stream } = agentRuntime.createRun('publisher', { content, platforms, mode: row.mode }, {
          workspaceId: row.workspace_id,
          db: { query, queryOne, exec },
          uuidv4,
        });
        await new Promise((resolve) => {
          stream.on('event', (evt) => {
            if (evt.type === 'complete') finalOutput = evt.data.output;
            if (evt.type === 'error') finalError = evt.data?.message;
            if (evt.type === 'closed') resolve();
          });
        });
      }

      // Direct mode: agent succeeds as long as it dispatched, but individual
      // platforms may have failed. If every platform failed, promote it to a
      // row-level error so the retry path engages. Intent mode doesn't have
      // per-platform success — its results are URL packages.
      if (!finalError && row.mode === 'direct' && finalOutput?.results?.length) {
        const anyOk = finalOutput.results.some(r => r.success);
        if (!anyOk) {
          finalError = finalOutput.results
            .map(r => `${r.platform}: ${r.error || 'failed'}`)
            .join('; ');
        }
      }

      if (finalError) {
        const attemptsSoFar = (row.attempts || 0) + 1; // we incremented above
        const maxAttempts = row.max_attempts || DEFAULT_MAX_ATTEMPTS;
        const canRetry = isRetryable(finalError) && attemptsSoFar < maxAttempts;

        if (canRetry) {
          const nextRetryAt = new Date(Date.now() + nextRetryDelayMs(attemptsSoFar)).toISOString();
          await exec(
            "UPDATE scheduled_publishes SET status='pending', next_retry_at=?, error_message=?, result=? WHERE id=?",
            [nextRetryAt, finalError.slice(0, 500), JSON.stringify({ error: finalError, output: finalOutput, attempt: attemptsSoFar }), row.id]
          );
          // We count it as failed for this tick, but it'll be retried.
          failed++;
        } else {
          await exec(
            "UPDATE scheduled_publishes SET status='error', result=?, error_message=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
            [JSON.stringify({ error: finalError, output: finalOutput, final_attempt: attemptsSoFar }), finalError.slice(0, 500), row.id]
          );
          failed++;
        }
      } else {
        await exec(
          "UPDATE scheduled_publishes SET status='complete', result=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
          [JSON.stringify(finalOutput), row.id]
        );
        ok++;
        const titleSnippet = (snapshot.title || snapshot.body || '').slice(0, 60);
        if (row.mode === 'direct') {
          const okCount = (finalOutput.results || []).filter(r => r.success).length;
          notifications?.notify?.({
            type: 'publish.scheduled.posted',
            level: 'success',
            title: 'Scheduled publish posted',
            message: `Posted to ${okCount}/${platforms.length} platform(s) for "${titleSnippet}"`,
          });
        } else {
          notifications?.notify?.({
            type: 'publish.scheduled.ready',
            level: 'success',
            title: 'Scheduled publish ready',
            message: `${platforms.length} platform intent URL(s) generated for "${titleSnippet}"`,
          });
        }
      }
    } catch (e) {
      // Thrown exceptions (parse errors, DB-level failures) are unusual —
      // keep the short-circuit error state and surface the message. Retries
      // for transient exceptions are handled above via the isRetryable path.
      await exec(
        "UPDATE scheduled_publishes SET status='error', result=?, error_message=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
        [JSON.stringify({ error: e.message }), (e.message || '').slice(0, 500), row.id]
      ).catch(() => {});
      failed++;
    }
  }
  return { processed: rows.length, ok, failed };
}

function start(deps, intervalMs = DEFAULT_INTERVAL_MS) {
  if (process.env.SCHED_PUBLISH_ENABLED === 'false') {
    console.log('[sched-publish] Disabled via SCHED_PUBLISH_ENABLED=false');
    return;
  }
  if (timer) return;
  const run = () => {
    if (ticking) return;
    ticking = true;
    processDue(deps).catch(e => console.warn('[sched-publish]', e.message)).finally(() => { ticking = false; });
  };
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[sched-publish] Started (tick every ${Math.round(intervalMs / 1000)}s)`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { processDue, start, stop, isRetryable, nextRetryDelayMs, BACKOFF_SCHEDULE_MINUTES };
