/**
 * Mail Agent - handles email sending via Resend API
 * Also supports legacy SMTP via nodemailer as fallback.
 *
 * As of 2026-04, `sendEmail` optionally accepts a `mailboxAccount` row
 * (from the `mailbox_accounts` table) to route through a per-workspace
 * account instead of the global env credentials. If `mailboxAccount` is
 * omitted or null, the env-based provider is used.
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

/**
 * Decrypt the credentials blob stored on a mailbox_accounts row. Tolerates:
 *   - aead:v1 ciphertext (new writes)
 *   - legacy plain JSON string (old writes before encryption was added)
 *   - already-parsed object (rare; defensive)
 */
const secrets = require('./secrets');
function parseCreds(mailbox) {
  if (!mailbox || !mailbox.credentials_encrypted) return {};
  if (typeof mailbox.credentials_encrypted === 'object') return mailbox.credentials_encrypted;
  try { return secrets.decrypt(mailbox.credentials_encrypted) || {}; }
  catch (e) {
    console.warn('[email] failed to decrypt mailbox creds:', e.message);
    return {};
  }
}

/**
 * Derive effective send config from either a mailbox row or env defaults.
 */
function resolveConfig(mailbox) {
  if (mailbox && mailbox.provider) {
    const creds = parseCreds(mailbox);
    return {
      provider: mailbox.provider,
      fromEmail: mailbox.from_email || process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER,
      fromName: mailbox.from_name || process.env.RESEND_FROM_NAME || process.env.SMTP_FROM_NAME || 'HakkoAI Team',
      replyTo: mailbox.reply_to || process.env.RESEND_REPLY_TO || null,
      signatureHtml: mailbox.signature_html || null,
      creds,
    };
  }
  const provider = getProvider();
  return {
    provider,
    fromEmail: process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || 'contact@market.hakko.ai',
    fromName: process.env.RESEND_FROM_NAME || process.env.SMTP_FROM_NAME || 'HakkoAI Team',
    replyTo: process.env.RESEND_REPLY_TO || 'market@hakko.ai',
    signatureHtml: null,
    creds: {
      api_key: process.env.RESEND_API_KEY,
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT,
      smtp_user: process.env.SMTP_USER,
      smtp_pass: process.env.SMTP_PASS,
    },
  };
}

/**
 * Build the final HTML body, appending a signature if present.
 */
function composeHtml(body, signatureHtml) {
  const bodyHtml = textToHtml(body);
  if (!signatureHtml) return bodyHtml;
  return `${bodyHtml}<br><br>${signatureHtml}`;
}

async function sendEmail({ to, subject, body, fromName, mailboxAccount, onCredsRefreshed }) {
  const cfg = resolveConfig(mailboxAccount);
  if (!cfg.provider) {
    return { success: false, error: 'Email not configured. Set RESEND_API_KEY, SMTP_*, or attach a mailbox account.' };
  }

  const effectiveFromName = fromName || cfg.fromName;

  if (cfg.provider === 'resend') {
    return sendViaResend({ to, subject, body, fromName: effectiveFromName, cfg });
  }
  if (cfg.provider === 'gmail_oauth') {
    const gmail = require('./mailbox-oauth-gmail');
    const from = `${effectiveFromName || 'Team'} <${cfg.fromEmail}>`;
    return gmail.sendViaGmail({
      to, subject, body, from,
      html: composeHtml(body, cfg.signatureHtml),
      creds: cfg.creds,
      onRefresh: onCredsRefreshed,
    });
  }
  return sendViaSMTP({ to, subject, body, fromName: effectiveFromName, cfg });
}

async function sendViaResend({ to, subject, body, fromName, cfg }) {
  const apiKey = cfg?.creds?.api_key || process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'Resend API key missing on mailbox account' };

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const fromEmail = cfg.fromEmail || 'contact@market.hakko.ai';
  const from = `${fromName || 'HakkoAI Team'} <${fromEmail}>`;

  try {
    const payload = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text: body,
      html: composeHtml(body, cfg.signatureHtml),
    };
    if (cfg.replyTo) payload.reply_to = cfg.replyTo;
    const { data, error } = await resend.emails.send(payload);

    if (error) {
      return { success: false, error: error.message || JSON.stringify(error) };
    }
    return { success: true, messageId: data?.id, provider: 'resend' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendViaSMTP({ to, subject, body, fromName, cfg }) {
  const creds = cfg.creds || {};
  const host = creds.smtp_host || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(creds.smtp_port || process.env.SMTP_PORT) || 587;
  const user = creds.smtp_user || process.env.SMTP_USER;
  const pass = creds.smtp_pass || process.env.SMTP_PASS;
  if (!user || !pass) return { success: false, error: 'SMTP credentials missing on mailbox account' };

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const fromEmail = cfg.fromEmail || user;
  const from = `${fromName || 'HakkoAI Team'} <${fromEmail}>`;

  try {
    const mail = {
      from,
      to,
      subject,
      text: body,
      html: composeHtml(body, cfg.signatureHtml),
    };
    if (cfg.replyTo) mail.replyTo = cfg.replyTo;
    const info = await transport.sendMail(mail);
    return { success: true, messageId: info.messageId, accepted: info.accepted, provider: 'smtp' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function verifyConnection(mailboxAccount) {
  const cfg = resolveConfig(mailboxAccount);
  if (!cfg.provider) return { configured: false };

  if (cfg.provider === 'resend') {
    const apiKey = cfg?.creds?.api_key || process.env.RESEND_API_KEY;
    return { configured: !!apiKey, verified: !!apiKey, provider: 'resend' };
  }

  if (cfg.provider === 'gmail_oauth') {
    // Refresh access_token to confirm the refresh_token is still valid, then
    // ping the Gmail profile endpoint. Returns the refreshed creds so the
    // caller can persist them.
    if (!cfg.creds?.refresh_token) {
      return { configured: false, verified: false, provider: 'gmail_oauth', error: 'No refresh_token — reconnect via OAuth' };
    }
    try {
      const gmail = require('./mailbox-oauth-gmail');
      const refreshed = await gmail.refreshAccessToken(cfg.creds);
      const profile = await gmail.fetchProfile(refreshed.access_token);
      return {
        configured: true, verified: true, provider: 'gmail_oauth',
        email: profile.email, refreshedCreds: refreshed,
      };
    } catch (e) {
      return { configured: true, verified: false, provider: 'gmail_oauth', error: e.message };
    }
  }

  try {
    const nodemailer = require('nodemailer');
    const creds = cfg.creds || {};
    const port = parseInt(creds.smtp_port || process.env.SMTP_PORT) || 587;
    const transport = nodemailer.createTransport({
      host: creds.smtp_host || process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: {
        user: creds.smtp_user || process.env.SMTP_USER,
        pass: creds.smtp_pass || process.env.SMTP_PASS,
      },
    });
    await transport.verify();
    return { configured: true, verified: true, provider: 'smtp' };
  } catch (e) {
    return { configured: true, verified: false, error: e.message, provider: 'smtp' };
  }
}

module.exports = { isConfigured, sendEmail, verifyConnection, getProvider, resolveConfig };
