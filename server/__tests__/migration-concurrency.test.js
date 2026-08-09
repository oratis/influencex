/**
 * Concurrency behavior of the migration runner.
 *
 * runPendingMigrations() read the applied set, ran the DDL, then INSERTed the
 * id. Two processes starting together both saw an empty set, both ran, and
 * the loser hit "UNIQUE constraint failed: schema_migrations.id" — which the
 * boot IIFE rethrows, so that instance exits(1). Not test-only: two Cloud Run
 * instances cold-starting with pending migrations hit exactly this window.
 *
 * Migrations are idempotent by contract (each swallows "already exists"), so
 * a concurrent double-run is benign; crashing over the bookkeeping row is
 * not. Postgres additionally serializes the whole run with an advisory lock,
 * which can't be exercised from SQLite here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Hermetic file-backed DB (same pattern as schema-contract.test.js) so this
// runs against the REAL schema + migration list without touching the
// developer's database.
const TMP_DB = path.join(
  os.tmpdir(),
  `influencex-migration-race-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DATABASE_URL = '';

const { query, queryOne, exec, initializeDatabase } = require('../database');
const { runPendingMigrations, MIGRATIONS } = require('../migrations');

const api = () => ({ query, queryOne, exec });

before(async () => {
  await initializeDatabase();
  // schema_migrations is created by the runner, not by initializeDatabase —
  // run once so the tests below can manipulate the bookkeeping table.
  await runPendingMigrations(api());
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* already gone */ }
  }
});

test('a peer recording a migration mid-run does not crash the runner', async () => {
  // Race the runner precisely: after it has computed `pending` but before its
  // own bookkeeping INSERT lands, a peer instance records the same id. The
  // runner's INSERT then raises a UNIQUE violation.
  const victim = MIGRATIONS[0].id;
  await exec('DELETE FROM schema_migrations WHERE id = ?', [victim]);

  const realExec = exec;
  let injected = false;
  const racingApi = {
    query,
    queryOne,
    exec: async (sql, params) => {
      if (!injected && /INSERT INTO schema_migrations/i.test(sql) && params && params[0] === victim) {
        injected = true;
        // The peer wins.
        await realExec('INSERT INTO schema_migrations (id, description) VALUES (?, ?)',
          [victim, 'recorded by a peer instance']);
      }
      return realExec(sql, params);
    },
  };

  const result = await runPendingMigrations(racingApi);
  assert.ok(injected, 'the race must actually have been injected');
  assert.ok(result.applied >= 0, 'runner resolves instead of throwing');

  const rows = await query('SELECT id FROM schema_migrations WHERE id = ?', [victim]);
  assert.equal(rows.rows.length, 1, 'exactly one bookkeeping row survives');
});

test('running twice in a row is a no-op the second time', async () => {
  await runPendingMigrations(api());
  const second = await runPendingMigrations(api());
  assert.equal(second.applied, 0, 'nothing pending on the second pass');
});

test('a genuine migration failure still aborts the boot', async () => {
  const failing = {
    query,
    queryOne,
    exec: async (sql, params) => {
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return exec(sql, params);
      throw new Error('disk I/O error');
    },
  };
  // Force one migration to be pending again so the loop has work to do.
  await exec('DELETE FROM schema_migrations WHERE id = ?', [MIGRATIONS[0].id]);
  await assert.rejects(runPendingMigrations(failing), /Migration .* failed: disk I\/O error/);
  // Restore so later tests/suites see a fully-migrated database.
  await runPendingMigrations(api());
});

test('the applied set is read after the lock is taken, not before', () => {
  // Guards the ordering that makes the Postgres advisory lock meaningful: an
  // instance queued behind a peer must see what that peer just applied. If
  // getAppliedMigrations() moved above acquireMigrationLock(), the waiter
  // would act on a stale snapshot and re-run everything.
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations.js'), 'utf8');
  const lockAt = src.indexOf('acquireMigrationLock(dbApi)');
  const readAt = src.indexOf('getAppliedMigrations(dbApi)', lockAt);
  assert.ok(lockAt > 0, 'lock acquisition not found');
  assert.ok(readAt > lockAt, 'applied set must be read inside the lock');
});
