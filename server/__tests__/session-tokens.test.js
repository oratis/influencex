/**
 * Session token storage tests.
 *
 * `sessions.id` used to BE the bearer token: anyone who read the table (a
 * backup, a log of a query, a SQL injection anywhere) could impersonate every
 * logged-in user. Tokens are now stored as sha256 in `sessions.token_hash`,
 * matching what the invitation and password-reset flows already do.
 *
 * The dangerous part of the rollout is the legacy fallback, which matches a
 * plaintext token against `sessions.id`. Because a raw token and a sha256
 * digest are both 64 hex chars, that branch MUST be constrained to rows with
 * `token_hash IS NULL` — otherwise someone who read a *hash* out of the DB
 * could replay the hash itself as a token. The last test here pins that.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, exec, initializeDatabase } = require('../database');
const { runPendingMigrations } = require('../migrations');
const auth = require('../auth');

let userId;

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
  userId = uuidv4();
  await exec(
    'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
    [userId, `session-test-${userId}@example.com`, 'x', 'Session Test']
  );
});

test('createSession stores a hash, never the token', async () => {
  const { token } = await auth.createSession(userId);
  assert.match(token, /^[0-9a-f]{64}$/);

  const byToken = await queryOne('SELECT id FROM sessions WHERE id = ?', [token]);
  assert.equal(byToken, undefined, 'the plaintext token must not be a row id');

  const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await queryOne('SELECT id, token_hash FROM sessions WHERE token_hash = ?', [expectedHash]);
  assert.ok(row, 'a row keyed by the token hash should exist');
  assert.notEqual(row.id, token);
  assert.equal(row.token_hash, expectedHash);
});

test('getSession resolves a session from the plaintext token', async () => {
  const { token } = await auth.createSession(userId);
  const user = await auth.getSession(token);
  assert.ok(user, 'valid token should resolve');
  assert.equal(user.id, userId);
});

test('getSession rejects the stored hash presented as a token', async () => {
  // The whole point of hashing: reading the DB must not yield a usable
  // credential. If the legacy `id = ?` branch ever loses its
  // `token_hash IS NULL` guard, this is what breaks.
  const { token } = await auth.createSession(userId);
  const storedHash = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(await auth.getSession(storedHash), null);
});

test('getSession rejects an unknown token', async () => {
  assert.equal(await auth.getSession(crypto.randomBytes(32).toString('hex')), null);
  assert.equal(await auth.getSession(''), null);
  assert.equal(await auth.getSession(null), null);
});

test('destroySession revokes by token', async () => {
  const { token } = await auth.createSession(userId);
  assert.ok(await auth.getSession(token));
  await auth.destroySession(token);
  assert.equal(await auth.getSession(token), null);
});

test('an expired session is rejected and deleted', async () => {
  const rowId = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await exec(
    'INSERT INTO sessions (id, user_id, expires_at, token_hash) VALUES (?, ?, ?, ?)',
    [rowId, userId, new Date(Date.now() - 1000).toISOString(), hash]
  );
  assert.equal(await auth.getSession(token), null);
  const gone = await queryOne('SELECT id FROM sessions WHERE id = ?', [rowId]);
  assert.equal(gone, undefined, 'expired row should be reaped on lookup');
});

// ==================== Legacy (pre-hash) rows ====================

test('a legacy plaintext row still authenticates until it expires', async () => {
  // Exactly what a row written before this change looks like: the token in
  // `id`, no token_hash. Nobody gets logged out by the migration.
  const legacyToken = crypto.randomBytes(32).toString('hex');
  await exec(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
    [legacyToken, userId, new Date(Date.now() + 3600_000).toISOString()]
  );
  const user = await auth.getSession(legacyToken);
  assert.ok(user, 'legacy session should still resolve');
  assert.equal(user.id, userId);

  await auth.destroySession(legacyToken);
  assert.equal(await auth.getSession(legacyToken), null);
});

test('the legacy branch cannot be used to replay a hashed row id', async () => {
  // Craft a row whose id happens to equal a known value, WITH a token_hash.
  // Presenting that id as a token must fail — the legacy lookup is gated on
  // token_hash IS NULL.
  const rowId = crypto.randomBytes(32).toString('hex');
  const realToken = crypto.randomBytes(32).toString('hex');
  await exec(
    'INSERT INTO sessions (id, user_id, expires_at, token_hash) VALUES (?, ?, ?, ?)',
    [rowId, userId, new Date(Date.now() + 3600_000).toISOString(),
     crypto.createHash('sha256').update(realToken).digest('hex')]
  );
  assert.equal(await auth.getSession(rowId), null, 'row id must not work as a token');
  assert.ok(await auth.getSession(realToken), 'the real token still works');
});

test('hashSessionToken is the same sha256 construct the other token flows use', () => {
  const t = 'some-token';
  assert.equal(auth.hashSessionToken(t), crypto.createHash('sha256').update(t).digest('hex'));
});
