/**
 * oauth_states expiry.
 *
 * Rows were only deleted on a *successful* callback, so every abandoned or
 * failed authorize flow left one behind forever: an unbounded, ever-growing
 * table of CSRF tokens that stayed replayable indefinitely.
 *
 * The fix has two halves, both exercised here against the real schema:
 *   - the callback looks up `state = ? AND created_at >= ?` so an expired
 *     state is indistinguishable from an unknown one,
 *   - a periodic sweep deletes anything past the TTL.
 *
 * created_at is written as a JS ISO string rather than the column default so
 * the comparison behaves identically on Postgres (string cast to timestamp)
 * and SQLite (lexicographic on ISO-8601).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, exec, initializeDatabase } = require('../database');
const { runPendingMigrations } = require('../migrations');

const TTL_MS = 10 * 60 * 1000;
const cutoffIso = () => new Date(Date.now() - TTL_MS).toISOString();

async function insertState(createdAt) {
  const state = crypto.randomBytes(16).toString('hex');
  await exec(
    'INSERT INTO oauth_states (state, workspace_id, user_id, platform, code_verifier, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [state, uuidv4(), uuidv4(), 'twitter', null, createdAt]
  );
  return state;
}

// The exact lookup the callback performs.
function lookup(state) {
  return queryOne('SELECT * FROM oauth_states WHERE state = ? AND created_at >= ?', [state, cutoffIso()]);
}

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

test('a fresh state is accepted by the callback lookup', async () => {
  const state = await insertState(new Date().toISOString());
  assert.ok(await lookup(state));
});

test('a state just inside the TTL is still accepted', async () => {
  const state = await insertState(new Date(Date.now() - TTL_MS + 30_000).toISOString());
  assert.ok(await lookup(state));
});

test('a state past the TTL is rejected exactly like an unknown one', async () => {
  const expired = await insertState(new Date(Date.now() - TTL_MS - 1000).toISOString());
  assert.equal(await lookup(expired), undefined);
  assert.equal(await lookup('never-existed'), undefined);
});

test('a long-abandoned state is rejected', async () => {
  const state = await insertState(new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
  assert.equal(await lookup(state), undefined);
});

test('rows carrying the old CURRENT_TIMESTAMP default are treated as expired', async () => {
  // Pre-change rows stored "YYYY-MM-DD HH:MM:SS", which sorts below any ISO
  // string (space < 'T'), so they can never satisfy the cutoff. That's the
  // intended outcome: they are abandoned flows.
  const state = await insertState('2026-08-09 12:00:00');
  assert.equal(await lookup(state), undefined);
});

test('the sweep deletes expired rows and keeps fresh ones', async () => {
  const fresh = await insertState(new Date().toISOString());
  const stale = await insertState(new Date(Date.now() - TTL_MS - 60_000).toISOString());

  await exec('DELETE FROM oauth_states WHERE created_at < ?', [cutoffIso()]);

  assert.ok(await queryOne('SELECT state FROM oauth_states WHERE state = ?', [fresh]), 'fresh state must survive');
  assert.equal(await queryOne('SELECT state FROM oauth_states WHERE state = ?', [stale]), undefined);
});

test('index.js wires the sweep into a periodic tick and enforces the TTL at callback time', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /const OAUTH_STATE_TTL_MS = 10 \* 60 \* 1000;/);
  assert.match(src, /DELETE FROM oauth_states WHERE created_at < \?/, 'sweep query missing');
  assert.match(src, /sweepExpiredOauthStates\(\)/, 'sweep is never called');
  assert.match(
    src,
    /SELECT \* FROM oauth_states WHERE state = \? AND created_at >= \?/,
    'callback lookup must enforce the TTL in SQL'
  );
});
