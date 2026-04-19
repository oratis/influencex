/**
 * Google SSO — OAuth 2.0 authorization code flow.
 *
 * Routes (wired in index.js):
 *   GET  /api/auth/google/init     → returns { url, state } for the frontend
 *                                    to window.location to
 *   GET  /api/auth/google/callback → handled by Google after user consents,
 *                                    exchanges code → token, upserts user,
 *                                    redirects the browser to the app with a
 *                                    session token in the URL fragment
 *
 * Env vars required:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   OAUTH_CALLBACK_BASE  (optional; defaults to https://influencexes.com)
 */

const crypto = require('crypto');
const fetch = require('./proxy-fetch');
const { queryOne, exec } = require('./database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const CALLBACK_BASE = process.env.OAUTH_CALLBACK_BASE || 'https://influencexes.com';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = 'openid email profile';

// In-memory state store (TTL 10min) — small, restart-tolerant enough for a
// single Cloud Run instance. For multi-instance, move to the oauth_states
// table with a TTL sweeper.
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore) if (v.expiresAt < now) stateStore.delete(k);
}, 5 * 60 * 1000);

function isConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function redirectUri() {
  return `${CALLBACK_BASE}/api/auth/google/callback`;
}

function buildAuthorizeUrl({ returnTo } = {}) {
  if (!isConfigured()) throw new Error('Google SSO not configured (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { expiresAt: Date.now() + STATE_TTL_MS, returnTo: returnTo || '/' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return { url: `${AUTH_URL}?${params.toString()}`, state };
}

async function exchangeCodeForIdentity(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange ${tokenRes.status}: ${t.slice(0, 200)}`);
  }
  const tokens = await tokenRes.json();

  const userRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!userRes.ok) throw new Error('Failed to fetch Google userinfo');
  const user = await userRes.json();
  // user: { sub, email, email_verified, name, given_name, family_name, picture, locale }
  if (!user.email || !user.sub) throw new Error('Google returned no email/sub');
  return user;
}

/**
 * Upsert a user from a Google profile. Behavior:
 *   - existing row by google_sub → update profile fields, return id
 *   - existing row by email → link google_sub, return id
 *   - no existing row → create new user with no password, return id
 */
async function upsertUserFromGoogle(profile) {
  // 1. Match by google_sub first (stable across email changes)
  let row = await queryOne('SELECT id FROM users WHERE google_sub = ?', [profile.sub]);
  if (row) {
    await exec('UPDATE users SET name = COALESCE(?, name), google_picture = COALESCE(?, google_picture), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [profile.name || null, profile.picture || null, profile.picture || null, row.id]);
    return row.id;
  }
  // 2. Match by email — link the account
  row = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [profile.email]);
  if (row) {
    await exec('UPDATE users SET google_sub = ?, google_picture = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
      [profile.sub, profile.picture || null, profile.picture || null, row.id]);
    return row.id;
  }
  // 3. Create new user. Password is unused but kept non-null where possible
  //    by generating a random hash the user can later reset.
  const id = uuidv4();
  const randomPassword = crypto.randomBytes(24).toString('hex');
  const hash = bcrypt.hashSync(randomPassword, 10);
  await exec(
    `INSERT INTO users (id, email, password_hash, name, avatar_url, google_sub, google_picture)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, profile.email, hash, profile.name || profile.email, profile.picture || null, profile.sub, profile.picture || null]
  );
  return id;
}

function consumeState(state) {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

module.exports = {
  isConfigured,
  buildAuthorizeUrl,
  exchangeCodeForIdentity,
  upsertUserFromGoogle,
  consumeState,
  redirectUri,
};
