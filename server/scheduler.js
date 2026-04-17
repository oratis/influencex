/**
 * Background email scheduler.
 *
 * Two responsibilities:
 *   1. Send "scheduled" contacts whose scheduled_send_at is in the past.
 *   2. Send follow-up reminders for contacts that were sent but haven't replied
 *      after FOLLOW_UP_AFTER_DAYS (default 4).
 *
 * Runs on a setInterval tick (default every 5 minutes). Disable by setting
 * SCHEDULER_ENABLED=false.
 *
 * Uses the existing DB schema — we reuse `contacts.sent_at`, `contacts.reply_at`,
 * and add `scheduled_send_at` and `follow_up_count` via a migration.
 */

const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULER_TICK_MS) || 5 * 60 * 1000;
const FOLLOW_UP_AFTER_DAYS = parseInt(process.env.FOLLOW_UP_AFTER_DAYS) || 4;
const MAX_FOLLOW_UPS = parseInt(process.env.MAX_FOLLOW_UPS) || 1;

let timer = null;
let ticking = false;

/**
 * Run one scheduler tick. Exposed for testing and manual triggering.
 */
async function tick({ query, exec, queryOne, mailAgent, notifications, uuidv4 }) {
  if (ticking) return { skipped: true };
  ticking = true;
  const result = { scheduled_sent: 0, follow_ups_sent: 0, errors: [] };

  try {
    // 1) Send any scheduled emails whose time has come
    const due = await query(
      `SELECT c.*, k.email as kol_email, k.display_name
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.scheduled_send_at IS NOT NULL
         AND c.scheduled_send_at <= CURRENT_TIMESTAMP
         AND c.status = 'draft'
       LIMIT 50`
    );

    for (const contact of (due.rows || [])) {
      if (!contact.kol_email) {
        result.errors.push({ contactId: contact.id, error: 'No recipient email' });
        continue;
      }
      if (!mailAgent.isConfigured()) {
        result.errors.push({ contactId: contact.id, error: 'Email provider not configured' });
        continue;
      }

      const send = await mailAgent.sendEmail({
        to: contact.kol_email,
        subject: contact.email_subject,
        body: contact.email_body,
      });

      if (send.success) {
        await exec(
          `UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP, scheduled_send_at=NULL WHERE id=?`,
          [contact.id]
        );
        await exec(
          `INSERT INTO email_replies (id, contact_id, direction, from_email, to_email, subject, body_text, resend_email_id, received_at)
           VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [uuidv4(), contact.id, process.env.RESEND_FROM_EMAIL || 'noreply@localhost',
            contact.kol_email, contact.email_subject, contact.email_body, send.messageId]
        );
        result.scheduled_sent += 1;
        notifications?.events.emailSent({
          kolName: contact.display_name || contact.kol_email,
          subject: contact.email_subject,
          to: contact.kol_email,
        });
      } else {
        result.errors.push({ contactId: contact.id, error: send.error });
      }
    }

    // 2) Follow-ups for sent-but-unreplied
    const cutoff = new Date(Date.now() - FOLLOW_UP_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const toFollowUp = await query(
      `SELECT c.*, k.email as kol_email, k.display_name
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.status = 'sent'
         AND c.reply_at IS NULL
         AND c.sent_at IS NOT NULL
         AND c.sent_at < ?
         AND COALESCE(c.follow_up_count, 0) < ?
       LIMIT 20`,
      [cutoff, MAX_FOLLOW_UPS]
    );

    for (const contact of (toFollowUp.rows || [])) {
      if (!contact.kol_email || !mailAgent.isConfigured()) continue;

      const followUpSubject = `Re: ${contact.email_subject}`;
      const followUpBody = `Hi ${contact.display_name || 'there'},\n\nJust circling back on my earlier note — totally understand if it's not the right fit, but wanted to make sure it didn't get buried.\n\nHappy to answer any questions.\n\nBest`;

      const send = await mailAgent.sendEmail({
        to: contact.kol_email,
        subject: followUpSubject,
        body: followUpBody,
      });

      if (send.success) {
        await exec(
          `UPDATE contacts SET follow_up_count = COALESCE(follow_up_count, 0) + 1 WHERE id=?`,
          [contact.id]
        );
        await exec(
          `INSERT INTO email_replies (id, contact_id, direction, from_email, to_email, subject, body_text, resend_email_id, received_at)
           VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [uuidv4(), contact.id, process.env.RESEND_FROM_EMAIL || 'noreply@localhost',
            contact.kol_email, followUpSubject, followUpBody, send.messageId]
        );
        result.follow_ups_sent += 1;
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
        console.log(`[scheduler] Sent ${r.scheduled_sent} scheduled + ${r.follow_ups_sent} follow-ups`);
      }
    });
  }, TICK_INTERVAL_MS);

  console.log(`[scheduler] Started (tick every ${Math.round(TICK_INTERVAL_MS / 1000)}s, follow-up after ${FOLLOW_UP_AFTER_DAYS}d)`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
