/**
 * Apify failure watchdog.
 *
 * Periodically scans `apify_runs` for rows stuck in `running` state past a
 * threshold and marks them `timeout`. This is a belt-and-braces guard for the
 * sync run-actor path where, in theory, every call returns a finish state —
 * but in practice serverless cold-starts, abort timeouts, or process crashes
 * can leave zombie rows that distort the per-workspace quota and confuse ops.
 *
 * Also exposes a query helper so the admin endpoint can list failed/timeout
 * runs for triage.
 */

const STUCK_THRESHOLD_MINUTES = parseInt(process.env.APIFY_STUCK_MINUTES) || 60;

async function reapStuckRuns({ exec, query }) {
  // SQLite + Postgres both accept this datetime arithmetic when expressed as
  // a parameter rather than a literal interval.
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  let reaped = 0;
  try {
    if (typeof query === 'function') {
      const r = await query(
        `SELECT id FROM apify_runs WHERE status = 'running' AND started_at < ?`,
        [cutoff]
      );
      const rows = r.rows || [];
      for (const row of rows) {
        await exec(
          `UPDATE apify_runs SET status='timeout', error_message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`,
          [`Reaped by watchdog after ${STUCK_THRESHOLD_MINUTES} min`, row.id]
        );
        reaped++;
      }
    }
  } catch (e) {
    // Don't throw — watchdog is a best-effort background job.
    console.warn('[apify-watchdog] reap failed:', e.message);
  }
  if (reaped > 0) {
    console.log(`[apify-watchdog] reaped ${reaped} stuck Apify run(s) older than ${STUCK_THRESHOLD_MINUTES}m`);
  }
  return { reaped, cutoff };
}

// Query helper for admin endpoint. Caller passes db facade.
async function listRecentRuns({ query }, { limit = 100, status } = {}) {
  try {
    let sql = `SELECT id, workspace_id, actor_id, run_id, status, cost_usd, duration_ms,
               error_message, started_at, finished_at FROM apify_runs`;
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(limit);
    const r = await query(sql, params);
    return r.rows || [];
  } catch (e) {
    console.warn('[apify-watchdog] listRecentRuns failed:', e.message);
    return [];
  }
}

let _interval = null;

function start({ exec, query, intervalMs = 30 * 60 * 1000 } = {}) {
  if (_interval) return;
  // First sweep on startup, then every intervalMs (default 30 min).
  reapStuckRuns({ exec, query }).catch(() => {});
  _interval = setInterval(() => reapStuckRuns({ exec, query }).catch(() => {}), intervalMs);
  console.log(`[apify-watchdog] Started (sweep every ${Math.round(intervalMs / 60000)} min, threshold ${STUCK_THRESHOLD_MINUTES} min)`);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop, reapStuckRuns, listRecentRuns, STUCK_THRESHOLD_MINUTES };
