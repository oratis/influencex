/**
 * Gmail mailbox OAuth — authorization code flow with offline scopes so we
 * can keep a refresh_token and send from the workspace's Gmail address.
 *
 * Routes (wired in index.js):
 *   POST /api/mailboxes/oauth/gmail/init     → returns { url, state }
 *   GET  /api/mailboxes/oauth/gmail/callback → exchanges code → tokens,
 *                                              creates a mailbox_accounts row,
 *                                              closes the popup.
 *
 * Env vars required to actually run the flow:
 *   GMAIL_OAUTH_CLIENT_ID
 *   GMAIL_OAUTH_CLIENT_SECRET
 *   OAUTH_CALLBACK_BASE            (optional; defaults to http://localhost:8080)
 *
 * Sending (in server/email.js) calls `sendViaGmail(cfg, to, subject, body)`,
 * which refreshes the access_token using refresh_token when needed, then
 * posts a base64-encoded RFC822 message to Gmail's users.messages.send.
 */

const crypto = require('crypto');
const fetch = require('./proxy-fetch');

const CALLBACK_BASE = process.env.OAUTH_CALLBACK_BASE || 'http://localhost:8080';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// gmail.send lets us send on the user's behalf; openid + email gives us the
// address to pre-fill `from_email`. No read/inbox scope on purpose.
const SCOPES = 'https://www.googleapis.com/auth/gmail.send openid email profile';

// In-memory state — carries the workspace_id + user_id for the callback so
// we know which workspace to attach the new mailbox to.
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore) if (v.expiresAt < now) stateStore.delete(k);
}, 5 * 60 * 1000).unref?.();

function isConfigured() {
  return !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET);
}

function redirectUri() {
  return `${CALLBACK_BASE}/api/mailboxes/oauth/gmail/callback`;
}

function buildAuthorizeUrl({ workspaceId, userId, returnTo } = {}) {
  if (!isConfigured()) throw new Error('Gmail OAuth not configured (missing GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET)');
  if (!workspaceId) throw new Error('workspaceId required');
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, {
    expiresAt: Date.now() + STATE_TTL_MS,
    workspaceId,
    userId: userId || null,
    returnTo: returnTo || '/',
  });
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',      // we need a refresh_token
    prompt: 'consent',           // force consent screen so refresh_token is issued
    state,
  });
  return { url: `${AUTH_URL}?${params}`, state };
}

function consumeState(state) {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // data: { access_token, expires_in, refresh_token, scope, token_type, id_token }
  return data;
}

async function fetchProfile(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Failed to fetch Google profile');
  return res.json(); // { sub, email, name, picture, ... }
}

/**
 * Exchange refresh_token for a fresh access_token. Returns the updated
 * creds object the caller should persist.
 */
async function refreshAccessToken(creds) {
  if (!creds?.refresh_token) throw new Error('No refresh_token to refresh');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    ...creds,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3500) * 1000,
  };
}

/**
 * Build the RFC822 message, base64url-encode, and POST to Gmail. The mailbox
 * account row's credentials_encrypted carries { access_token, refresh_token,
 * expires_at }. If the access_token is expired, we refresh first — the caller
 * is responsible for persisting the new creds.
 */
async function sendViaGmail({ to, subject, body, from, html, creds, onRefresh }) {
  let effectiveCreds = creds || {};
  if (!effectiveCreds.access_token || (effectiveCreds.expires_at && Date.now() > effectiveCreds.expires_at - 30_000)) {
    effectiveCreds = await refreshAccessToken(effectiveCreds);
    if (onRefresh) { try { await onRefresh(effectiveCreds); } catch {} }
  }

  const msg = buildRFC822({ to, from, subject, text: body, html });
  const raw = Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${effectiveCreds.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `Gmail send failed: ${res.status} ${text.slice(0, 300)}` };
  }
  const data = await res.json();
  return { success: true, messageId: data.id, provider: 'gmail_oauth' };
}

function buildRFC822({ to, from, subject, text, html }) {
  // Minimal multipart/alternative so recipients with HTML-only clients still
  // see a formatted body. Boundary is hard-coded because we fully own both
  // parts — no user-supplied content can collide.
  const boundary = 'influx_' + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    text || '',
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    html || (text || '').replace(/\n/g, '<br>'),
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

module.exports = {
  isConfigured,
  buildAuthorizeUrl,
  consumeState,
  exchangeCodeForTokens,
  fetchProfile,
  refreshAccessToken,
  sendViaGmail,
};
