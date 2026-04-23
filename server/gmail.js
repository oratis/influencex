/**
 * Gmail API sender — mints outreach emails from a workspace's connected
 * Gmail account instead of the shared Resend/SMTP sender.
 *
 * Token model: the OAuth callback in server/index.js encrypts the Gmail
 * access_token + refresh_token with server/encryption.js and writes them
 * to platform_connections.{access_token, refresh_token}. This module
 * decrypts on read, refreshes the access_token when expired, and writes
 * the refreshed token back (still encrypted).
 *
 * Why directly hit https://gmail.googleapis.com/gmail/v1/users/me/messages/send
 * instead of pulling googleapis: one HTTP call, zero transitive deps,
 * matches how server/publish/oauth.js talks to every other provider.
 */

const fetch = require('./proxy-fetch');
const { encrypt, decrypt } = require('./encryption');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
// Refresh a minute before expiry to absorb clock skew and short network lag.
const EXPIRY_SKEW_MS = 60 * 1000;

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loadConnection({ queryOne, workspaceId }) {
  const row = await queryOne(
    'SELECT id, access_token, refresh_token, expires_at, account_name, account_id FROM platform_connections WHERE workspace_id = ? AND platform = ?',
    [workspaceId, 'gmail']
  );
  if (!row) return null;
  return {
    id: row.id,
    accessToken: decrypt(row.access_token),
    refreshToken: decrypt(row.refresh_token),
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    accountName: row.account_name,
    accountId: row.account_id,
  };
}

async function refreshAccessToken({ exec, connectionId, refreshToken }) {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET not configured');
  if (!refreshToken) throw new Error('Gmail connection has no refresh_token — reconnect the account (requires access_type=offline + prompt=consent).');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gmail token refresh ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const newAccess = data.access_token;
  const expiresIn = data.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await exec(
    'UPDATE platform_connections SET access_token = ?, expires_at = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
    [encrypt(newAccess), expiresAt, connectionId]
  );
  return newAccess;
}

async function ensureFreshAccessToken(deps, conn) {
  const expired = conn.expiresAt && conn.expiresAt.getTime() - Date.now() < EXPIRY_SKEW_MS;
  if (!expired) return conn.accessToken;
  return refreshAccessToken({
    exec: deps.exec,
    connectionId: conn.id,
    refreshToken: conn.refreshToken,
  });
}

function buildRFC2822Message({ from, to, subject, textBody, htmlBody, replyTo }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(textBody || '', 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlBody || textBody || '', 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
  ].filter(Boolean);
  return lines.join('\r\n');
}

/**
 * Send an email via the workspace's Gmail connection.
 * Returns { success, messageId?, provider:'gmail', from?, error? }.
 *
 * `deps` wires in the DB helpers so this module doesn't pull database.js
 * directly — matches the pattern used elsewhere (scheduler.js etc).
 */
async function sendViaGmail({ deps, workspaceId, to, subject, textBody, htmlBody, fromName, replyTo }) {
  const { queryOne, exec } = deps;
  const conn = await loadConnection({ queryOne, workspaceId });
  if (!conn) return { success: false, error: 'No Gmail connection for this workspace' };

  let accessToken;
  try {
    accessToken = await ensureFreshAccessToken({ exec }, conn);
  } catch (e) {
    return { success: false, error: e.message };
  }

  const fromAddr = conn.accountId || conn.accountName;
  if (!fromAddr) return { success: false, error: 'Gmail connection missing email address — reconnect' };
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const raw = buildRFC2822Message({ from, to, subject, textBody, htmlBody, replyTo });
  const body = JSON.stringify({ raw: base64url(raw) });

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `Gmail API ${res.status}: ${text.slice(0, 300)}` };
  }
  const data = await res.json();
  await exec('UPDATE platform_connections SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [conn.id]);
  return {
    success: true,
    messageId: data.id || null,
    provider: 'gmail',
    from: fromAddr,
  };
}

async function hasConnection({ queryOne, workspaceId }) {
  if (!workspaceId) return false;
  const row = await queryOne(
    'SELECT 1 FROM platform_connections WHERE workspace_id = ? AND platform = ? LIMIT 1',
    [workspaceId, 'gmail']
  );
  return !!row;
}

module.exports = { sendViaGmail, hasConnection, buildRFC2822Message };
