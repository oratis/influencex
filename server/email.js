/**
 * Mail Agent - handles email sending.
 *
 * Provider priority per send:
 *   1. Workspace's connected Gmail account (if workspaceId is passed and the
 *      workspace has a gmail row in platform_connections). Uses OAuth 2.0 +
 *      gmail.send scope via server/gmail.js.
 *   2. Resend (RESEND_API_KEY) — shared sender for workspaces without Gmail.
 *   3. SMTP (SMTP_HOST/USER/PASS) — legacy fallback.
 *
 * The workspaceId param is optional so admin/system sends (password reset
 * emails, etc.) that don't belong to a workspace still work via Resend.
 */

const gmailSender = require('./gmail');

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function textToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function isConfigured() {
  // Gmail counts as "configured" at the deployment level only once the env
  // credentials exist; whether a specific workspace has connected is checked
  // per-send via hasConnection().
  const gmailEnv = !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET);
  return gmailEnv || !!process.env.RESEND_API_KEY || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return null;
}

async function sendEmail({ to, subject, body, fromName, workspaceId, replyTo }) {
  // Prefer the workspace's Gmail connection when one exists.
  if (workspaceId) {
    try {
      const { queryOne, exec } = require('./database');
      if (await gmailSender.hasConnection({ queryOne, workspaceId })) {
        const result = await gmailSender.sendViaGmail({
          deps: { queryOne, exec },
          workspaceId,
          to,
          subject,
          textBody: body,
          htmlBody: textToHtml(body),
          fromName,
          replyTo: replyTo || process.env.RESEND_REPLY_TO || undefined,
        });
        if (result.success) return result;
        // Gmail configured but sending failed (expired refresh_token, scope
        // revoked, Google API outage). Fall back to the shared sender so the
        // user's outreach still goes out — they'll fix the connection when
        // they see the error surfaced elsewhere.
        console.warn('[email] Gmail send failed, falling back to shared sender:', result.error);
      }
    } catch (e) {
      console.warn('[email] Gmail provider threw, falling back:', e.message);
    }
  }

  const provider = getProvider();
  if (!provider) {
    return { success: false, error: 'Email not configured. Set GMAIL_OAUTH_CLIENT_ID+SECRET (with a connected workspace), RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS.' };
  }

  if (provider === 'resend') {
    return sendViaResend({ to, subject, body, fromName });
  }
  return sendViaSMTP({ to, subject, body, fromName });
}

async function sendViaResend({ to, subject, body, fromName }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'contact@market.hakko.ai';
  const replyTo = process.env.RESEND_REPLY_TO || 'market@hakko.ai';
  const from = `${fromName || 'HakkoAI Team'} <${fromEmail}>`;

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      text: body,
      html: textToHtml(body),
    });

    if (error) {
      return { success: false, error: error.message || JSON.stringify(error) };
    }

    return {
      success: true,
      messageId: data?.id,
      provider: 'resend',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendViaSMTP({ to, subject, body, fromName }) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_PORT || '587') === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const from = `${fromName || process.env.SMTP_FROM_NAME || 'HakkoAI Team'} <${process.env.SMTP_USER}>`;

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
      html: textToHtml(body),
    });

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
      provider: 'smtp',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function verifyConnection() {
  const provider = getProvider();
  if (!provider) return { configured: false };

  if (provider === 'resend') {
    // Resend doesn't have a verify method, just check the key exists
    return { configured: true, verified: true, provider: 'resend' };
  }

  // SMTP verify
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_PORT || '587') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.verify();
    return { configured: true, verified: true, provider: 'smtp' };
  } catch (e) {
    return { configured: true, verified: false, error: e.message, provider: 'smtp' };
  }
}

module.exports = { isConfigured, sendEmail, verifyConnection, getProvider };
