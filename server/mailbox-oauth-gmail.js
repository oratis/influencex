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

/**
 * Strip anything that could terminate a header line.
 *
 * The subject and recipient reach here from user-editable fields (outreach
 * template, contact record). Concatenating them into the raw RFC822 message
 * means a subject of `Hi\r\nBcc: everyone@rival.example` injects a real Bcc
 * header — the classic email header injection. CR and LF (plus the NULs and
 * lone Unicode line separators some clients fold on) are removed outright
 * rather than rejected, so a stray newline in a template doesn't hard-fail a
 * send. Also caps length: RFC 5322 limits a header line to 998 octets.
 */
function sanitizeHeaderValue(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029\0]+/g, ' ')
    .trim()
    .slice(0, 900);
}

/**
 * RFC 2047 encoded-word for header values containing non-ASCII. Without this
 * a Chinese subject line goes onto the wire as raw UTF-8 in a header, which
 * receivers are free to mangle. Base64 rather than Q-encoding because our
 * non-ASCII case is CJK, where B is both shorter and simpler. Encoded words
 * are capped at 75 chars including the delimiters, so long subjects are split
 * across several folded words.
 */
function encodeHeaderValue(value) {
  const clean = sanitizeHeaderValue(value);
  if (!clean) return '';
  if (/^[\x20-\x7E]*$/.test(clean)) return clean; // pure ASCII — leave as-is
  const prefix = '=?UTF-8?B?';
  const suffix = '?=';
  // 36 input bytes → 48 base64 chars → 58 chars per encoded word. That keeps
  // even `Subject: ` + one word inside the 78-char line budget of RFC 5322,
  // and 36 divides evenly by 3 so CJK (3 bytes/char) never straddles a word.
  const maxBytesPerWord = 36;
  const buf = Buffer.from(clean, 'utf8');
  const words = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(offset + maxBytesPerWord, buf.length);
    // Don't split a multi-byte character across words.
    while (end < buf.length && (buf[end] & 0xC0) === 0x80) end--;
    words.push(prefix + buf.subarray(offset, end).toString('base64') + suffix);
    offset = end;
  }
  // Folding whitespace between encoded words: CRLF + space is the continuation.
  return words.join('\r\n ');
}

/**
 * Address headers (From / To) need the display name encoded but the
 * addr-spec left alone — `=?UTF-8?B?...?=` around `<a@b.com>` would produce
 * an unroutable address. Handles the `Name <addr>` form and bare addresses,
 * and preserves comma-separated lists.
 */
function encodeAddressHeader(value) {
  const clean = sanitizeHeaderValue(value);
  if (!clean) return '';
  return clean.split(',').map(part => {
    const m = part.trim().match(/^(.*?)\s*<([^<>]*)>$/);
    if (!m) return part.trim();
    const [, name, addr] = m;
    // An addr-spec is ASCII by definition; drop anything else rather than
    // letting it through unencoded.
    const safeAddr = addr.replace(/[^\x21-\x7E]/g, '');
    if (!name) return `<${safeAddr}>`;
    // Strip quotes the caller may have added; we re-quote or encode ourselves.
    const bareName = name.replace(/^"|"$/g, '');
    const encodedName = /^[\x20-\x7E]*$/.test(bareName)
      ? `"${bareName.replace(/["\\]/g, '')}"`
      : encodeHeaderValue(bareName);
    return `${encodedName} <${safeAddr}>`;
  }).join(', ');
}

function buildRFC822({ to, from, subject, text, html }) {
  // Minimal multipart/alternative so recipients with HTML-only clients still
  // see a formatted body. Boundary is random per message; the body parts are
  // base64-encoded so user content can never collide with it, and so a
  // non-ASCII body is not shipped as 8-bit under a `7bit` declaration.
  const boundary = 'influx_' + Math.random().toString(36).slice(2);
  const plain = text || '';
  const rich = html || plain.replace(/\n/g, '<br>');
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const lines = [
    `From: ${encodeAddressHeader(from)}`,
    `To: ${encodeAddressHeader(to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    b64(plain),
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    b64(rich),
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
  // Exported for tests / reuse by other raw-message builders.
  buildRFC822,
  sanitizeHeaderValue,
  encodeHeaderValue,
  encodeAddressHeader,
};
