/**
 * Background email scheduler.
 *
 * Two responsibilities:
 *   1. Enqueue "scheduled" contacts whose scheduled_send_at is in the past.
 *   2. Enqueue follow-up reminders for contacts that were sent but haven't
 *      replied after FOLLOW_UP_AFTER_DAYS (default 4).
 *
 * Runs on a setInterval tick (default every 5 minutes). Disable by setting
 * SCHEDULER_ENABLED=false.
 *
 * As of Phase 2, scheduled sends route through the shared `jobQueue` via
 * `email.send` jobs — the queue handles retries, error capture, and
 * provider_message_id tracking. Follow-ups are still written directly
 * because they need a distinct subject/body per tick and don't carry a
 * draft on `contacts`.
 */

const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULER_TICK_MS) || 5 * 60 * 1000;
// Multi-step follow-up schedule. Days between original send and each
// follow-up. Default "4,10" = first follow-up 4 days after the outreach,
// second one 10 days in. Set FOLLOW_UP_INTERVALS_DAYS="" to disable.
// Legacy FOLLOW_UP_AFTER_DAYS + MAX_FOLLOW_UPS still respected as fallback.
const FOLLOW_UP_INTERVALS_DAYS = (process.env.FOLLOW_UP_INTERVALS_DAYS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
const LEGACY_AFTER_DAYS = parseInt(process.env.FOLLOW_UP_AFTER_DAYS) || 4;
const LEGACY_MAX_FOLLOW_UPS = parseInt(process.env.MAX_FOLLOW_UPS) || 1;
const INTERVALS = FOLLOW_UP_INTERVALS_DAYS.length > 0
  ? FOLLOW_UP_INTERVALS_DAYS
  : Array.from({ length: LEGACY_MAX_FOLLOW_UPS }, () => LEGACY_AFTER_DAYS);

let timer = null;
let ticking = false;

/**
 * Run one scheduler tick. Exposed for testing and manual triggering.
 */
async function tick({ query, exec, queryOne, mailAgent, notifications, uuidv4, jobQueue }) {
  if (ticking) return { skipped: true };
  ticking = true;
  const result = { scheduled_sent: 0, follow_ups_sent: 0, errors: [] };

  try {
    // 1) Enqueue any scheduled emails whose time has come. The job queue
    //    handler (email.send) then performs the actual provider call.
    // Compare against a JS-computed ISO string rather than CURRENT_TIMESTAMP:
    // SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" UTC, but we store
    // scheduled_send_at as full ISO 8601 ("T"/"Z"), so lexicographic
    // comparison between them is wrong. Both sides must share a format —
    // sending the ISO string as a param keeps ordering correct on SQLite and
    // Postgres (same approach as scheduled-publish.js).
    const nowIso = new Date().toISOString();
    const due = await query(
      `SELECT c.id, c.scheduled_send_at, k.email as kol_email
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.scheduled_send_at IS NOT NULL
         AND c.scheduled_send_at <= ?
         AND c.status IN ('draft', 'scheduled')
       LIMIT 50`,
      [nowIso]
    );

    for (const contact of (due.rows || [])) {
      if (!contact.kol_email) {
        result.errors.push({ contactId: contact.id, error: 'No recipient email' });
        continue;
      }
      // Clear the schedule + flip to pending, then enqueue.
      await exec(
        `UPDATE contacts SET scheduled_send_at = NULL, status = 'pending', send_error = NULL WHERE id = ?`,
        [contact.id]
      );
      if (jobQueue) {
        try { jobQueue.push('email.send', { contactId: contact.id }, { maxRetries: 3 }); }
        catch (e) { result.errors.push({ contactId: contact.id, error: e.message }); }
      } else {
        result.errors.push({ contactId: contact.id, error: 'job queue unavailable' });
      }
      result.scheduled_sent += 1;
    }

    // 2) Multi-step follow-ups. A contact with follow_up_count=N is eligible
    //    for follow-up N+1 once INTERVALS[N] days have passed since sent_at.
    //    We compute the cutoff per eligible N and pick the tightest one each
    //    tick. Simpler: for each step i in INTERVALS, find contacts whose
    //    follow_up_count == i AND sent_at + intervals[i] <= now.
    const toFollowUp = { rows: [] };
    for (let step = 0; step < INTERVALS.length; step++) {
      const days = INTERVALS[step];
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const batch = await query(
        `SELECT c.*, k.email as kol_email, k.display_name
         FROM contacts c JOIN kols k ON c.kol_id = k.id
         WHERE c.status IN ('sent', 'delivered', 'opened')
           AND c.reply_at IS NULL
           AND c.sent_at IS NOT NULL
           AND c.sent_at < ?
           AND COALESCE(c.follow_up_count, 0) = ?
         LIMIT 20`,
        [cutoff, step]
      );
      for (const row of (batch.rows || [])) toFollowUp.rows.push(row);
    }

    for (const contact of (toFollowUp.rows || [])) {
      if (!contact.kol_email) continue;

      const followUpSubject = `Re: ${contact.email_subject}`;
      const followUpBody = `Hi ${contact.display_name || 'there'},\n\nJust circling back on my earlier note — totally understand if it's not the right fit, but wanted to make sure it didn't get buried.\n\nHappy to answer any questions.\n\nBest`;

      if (!jobQueue) continue;
      // Enqueue via the same worker; kind='followup' tells the handler to
      // bump follow_up_count instead of flipping status=sent (which would
      // regress replied/opened contacts — though we already filter those
      // out with reply_at IS NULL).
      try {
        jobQueue.push('email.send', {
          contactId: contact.id,
          subjectOverride: followUpSubject,
          bodyOverride: followUpBody,
          kind: 'followup',
        }, { maxRetries: 3 });
        result.follow_ups_sent += 1;
      } catch (e) {
        result.errors.push({ contactId: contact.id, error: e.message });
      }
    }

    return result;
  } catch (e) {
    result.errors.push({ error: e.message });
    return result;
  } finally {
    ticking = false;
  }
}

function start(deps) {
  if (process.env.SCHEDULER_ENABLED === 'false') {
    console.log('[scheduler] Disabled via SCHEDULER_ENABLED=false');
    return;
  }
  if (timer) return; // already running

  // First run after 30s (give server time to initialize)
  setTimeout(() => {
    tick(deps).then(r => {
      if (r.scheduled_sent || r.follow_ups_sent || r.errors?.length) {
        console.log('[scheduler] First tick:', r);
      }
    });
  }, 30_000);

  timer = setInterval(() => {
    tick(deps).then(r => {
      if (r.scheduled_sent || r.follow_ups_sent) {
        console.log(`[scheduler] Enqueued ${r.scheduled_sent} scheduled + ${r.follow_ups_sent} follow-ups`);
      }
    });
  }, TICK_INTERVAL_MS);

  console.log(`[scheduler] Started (tick every ${Math.round(TICK_INTERVAL_MS / 1000)}s, follow-up intervals: ${INTERVALS.length > 0 ? INTERVALS.join('d, ') + 'd' : 'none'})`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
