/**
 * Background email-send handlers registered on the shared job queue.
 *
 * Exposes three job types:
 *   email.send         — send a single contact's draft, record event, update status
 *   email.batch_send   — expand to N email.send jobs for a set of contact ids
 *   email.sync_status  — safety-net sweep: mark contacts queued for >30m as failed
 *
 * Each handler takes (job) where job.payload contains the work. The handler
 * *throws* on transient failure to let the queue retry; terminal errors are
 * persisted and return normally.
 */

const { v4: uuidv4 } = require('uuid');
const secrets = require('./secrets');
const log = require('./logger');

function register({ jobQueue, query, queryOne, exec, mailAgent, notifications }) {
  async function resolveMailbox(contact) {
    if (!contact.mailbox_account_id) {
      // try workspace default
      if (contact.workspace_id) {
        return await queryOne(
          'SELECT * FROM mailbox_accounts WHERE workspace_id = ? AND is_default = 1 AND status = \'active\' ORDER BY created_at ASC LIMIT 1',
          [contact.workspace_id]
        );
      }
      return null;
    }
    return await queryOne(
      'SELECT * FROM mailbox_accounts WHERE id = ? AND status = \'active\'',
      [contact.mailbox_account_id]
    );
  }

  async function recordEvent({ workspaceId, contactId, providerMessageId, eventType, payload }) {
    try {
      await exec(
        `INSERT INTO email_events (id, workspace_id, contact_id, provider_message_id, event_type, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), workspaceId || null, contactId || null, providerMessageId || null, eventType, JSON.stringify(payload || {})]
      );
    } catch (e) {
      log.warn('[email-jobs] failed to record event:', e.message);
    }
  }

  // ---- email.send ----
  // payload: { contactId, toOverride?, subjectOverride?, bodyOverride?, kind? }
  // kind='followup' skips the "already sent" short-circuit so follow-ups
  // can be enqueued against contacts in status='sent' / 'delivered' / 'opened'.
  jobQueue.register('email.send', async (job) => {
    const { contactId, toOverride, subjectOverride, bodyOverride, kind } = job.payload || {};
    if (!contactId) throw new Error('email.send requires contactId');

    const contact = await queryOne(
      `SELECT c.*, k.email as kol_email, k.display_name, k.username,
              k.email_blocked_at, k.email_blocked_reason
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.id = ?`,
      [contactId]
    );
    if (!contact) {
      // terminal: swallow, the contact was deleted.
      return { skipped: 'contact not found' };
    }
    // Hard-bounce guardrail: if the KOL's email was previously flagged by the
    // auto-disable logic (see webhook handler), refuse to send. The contact
    // stays in a "failed" terminal state with a clear reason.
    if (contact.email_blocked_at) {
      await exec(
        `UPDATE contacts SET status='failed', send_error=?, last_send_attempt_at=CURRENT_TIMESTAMP WHERE id=?`,
        [`Recipient blocked: ${contact.email_blocked_reason || 'repeated hard bounces'}`, contactId]
      );
      return { failed: true, error: 'recipient_blocked' };
    }
    const isFollowUp = kind === 'followup';
    if (!isFollowUp && ['sent', 'delivered', 'opened', 'replied'].includes(contact.status)) {
      return { skipped: `already ${contact.status}` };
    }

    const emailTo = toOverride || contact.kol_email;
    if (!emailTo) {
      await exec(
        `UPDATE contacts SET status='failed', send_error='No recipient email', last_send_attempt_at=CURRENT_TIMESTAMP WHERE id=?`,
        [contactId]
      );
      return { failed: true, error: 'no recipient' };
    }

    const subject = subjectOverride || contact.email_subject;
    const body = bodyOverride || contact.email_body;
    if (!subject || !body) {
      await exec(
        `UPDATE contacts SET status='failed', send_error='Empty subject/body', last_send_attempt_at=CURRENT_TIMESTAMP WHERE id=?`,
        [contactId]
      );
      return { failed: true, error: 'empty subject/body' };
    }

    const mailbox = await resolveMailbox(contact);

    // Dev fallback: if no provider config, mark sent (keeps existing behavior).
    if (!mailAgent.isConfigured() && !mailbox) {
      await exec(
        `UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP, send_error=NULL, last_send_attempt_at=CURRENT_TIMESTAMP, send_attempts=COALESCE(send_attempts,0)+1 WHERE id=?`,
        [contactId]
      );
      return { dryRun: true };
    }

    await exec(
      `UPDATE contacts SET send_attempts = COALESCE(send_attempts, 0) + 1, last_send_attempt_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [contactId]
    );

    const result = await mailAgent.sendEmail({
      to: emailTo,
      subject,
      body,
      mailboxAccount: mailbox,
      // Persist refreshed Gmail tokens so the next send uses the new access_token
      onCredsRefreshed: async (fresh) => {
        if (!mailbox?.id) return;
        try {
          await exec(
            'UPDATE mailbox_accounts SET credentials_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [secrets.encrypt(fresh), mailbox.id]
          );
        } catch (e) {
          log.warn('[email-jobs] failed to persist refreshed creds:', e.message);
        }
      },
    });

    if (!result.success) {
      // Transient vs terminal distinction: network-ish errors -> throw to retry.
      const err = result.error || 'Send failed';
      const isTerminal = /invalid|missing|not configured|rejected|400|401|403|422/i.test(err);
      await exec(
        `UPDATE contacts SET status = ?, send_error = ? WHERE id = ?`,
        [isTerminal ? 'failed' : 'pending', err.slice(0, 500), contactId]
      );
      await recordEvent({
        workspaceId: contact.workspace_id,
        contactId,
        eventType: 'failed',
        payload: { error: err, terminal: isTerminal },
      });
      if (!isTerminal) throw new Error(err); // let the queue retry
      return { failed: true, error: err };
    }

    const fromEmail = mailbox?.from_email || process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || 'noreply@localhost';
    // For follow-ups we don't regress the status; just bump the counter.
    // The contact stays in whatever engagement state it reached previously.
    if (isFollowUp) {
      await exec(
        `UPDATE contacts SET follow_up_count = COALESCE(follow_up_count, 0) + 1, send_error = NULL WHERE id = ?`,
        [contactId]
      );
    } else {
      await exec(
        `UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP, send_error=NULL, provider_message_id=? WHERE id=?`,
        [result.messageId || null, contactId]
      );
    }
    await exec(
      `INSERT INTO email_replies (id, workspace_id, contact_id, direction, from_email, to_email, subject, body_text, resend_email_id, received_at)
       VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [uuidv4(), contact.workspace_id || null, contactId, fromEmail, emailTo, subject, body, result.messageId || null]
    );
    await recordEvent({
      workspaceId: contact.workspace_id,
      contactId,
      providerMessageId: result.messageId,
      eventType: 'sent',
      payload: { provider: result.provider, to: emailTo },
    });

    notifications?.events?.emailSent?.({
      kolName: contact.display_name || emailTo,
      subject: contact.email_subject,
      to: emailTo,
    });

    return { success: true, messageId: result.messageId };
  });

  // ---- email.batch_send ----
  jobQueue.register('email.batch_send', async (job) => {
    const { contactIds = [] } = job.payload || {};
    let enqueued = 0;
    for (const cid of contactIds) {
      try {
        jobQueue.push('email.send', { contactId: cid }, { maxRetries: 3 });
        enqueued += 1;
      } catch (e) {
        log.warn('[email-jobs] failed to enqueue child:', e.message);
      }
    }
    return { enqueued };
  });

  // ---- email.sync_status ----
  // Mark any contact stuck in "pending" for >30 minutes as failed so the UI
  // shows a clear error instead of an endless spinner.
  jobQueue.register('email.sync_status', async () => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const result = await exec(
      `UPDATE contacts
       SET status = 'failed', send_error = COALESCE(send_error, 'Timed out waiting for send')
       WHERE status = 'pending' AND (last_send_attempt_at IS NULL OR last_send_attempt_at < ?)`,
      [cutoff]
    );
    return { cleared: result.rowCount || 0 };
  });
}

module.exports = { register };
