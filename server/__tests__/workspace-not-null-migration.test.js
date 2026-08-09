/**
 * Tests for the workspace_id NOT NULL migration and the demo seeder.
 *
 * Background: every workspace_id column was left nullable after the
 * multitenancy migration (docs/MULTITENANCY.md §2's tightening step was
 * never executed). That is what let runPipeline write invisible
 * NULL-workspace kol_database rows for months without anyone noticing —
 * scoped reads simply skip them, so nothing ever looked broken.
 *
 * The migration closes that gap on Postgres, but must never take the boot
 * down: a table that still holds orphan rows is left nullable with a warning
 * so an operator can triage. Postgres isn't available in unit tests, so the
 * SQL is asserted at the source level plus the guard behavior is exercised
 * with a fake driver.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS, MULTITENANT_TABLES } = require('../migrations');

const MIGRATION_ID = '2026-08-09-workspace-id-not-null';

function findMigration() {
  const m = MIGRATIONS.find(x => x.id === MIGRATION_ID);
  assert.ok(m, `migration ${MIGRATION_ID} must exist`);
  return m;
}

// Fake driver: records statements, answers orphan-count queries from a map.
function fakeDb({ orphansByTable = {}, missingTables = [] } = {}) {
  const execs = [];
  return {
    execs,
    usePostgres: true,
    exec: async (sql) => { execs.push(sql); },
    query: async (sql) => {
      const table = (sql.match(/FROM (\w+)/) || [])[1];
      if (missingTables.includes(table)) {
        const err = new Error(`relation "${table}" does not exist`);
        throw err;
      }
      return { rows: [{ n: orphansByTable[table] || 0 }] };
    },
  };
}

test('migration is registered exactly once with a unique id', () => {
  const matches = MIGRATIONS.filter(m => m.id === MIGRATION_ID);
  assert.equal(matches.length, 1);
  const ids = MIGRATIONS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'all migration ids must be unique');
});

test('SQLite is a no-op: no ALTER runs when usePostgres is false', async () => {
  const db = fakeDb();
  db.usePostgres = false;
  await findMigration().up(db);
  assert.deepEqual(db.execs, [], 'SQLite cannot ALTER COLUMN — must skip entirely');
});

test('callers that omit usePostgres are treated as SQLite (no ALTER)', async () => {
  const execs = [];
  await findMigration().up({
    exec: async (sql) => { execs.push(sql); },
    query: async () => ({ rows: [{ n: 0 }] }),
  });
  assert.deepEqual(execs, []);
});

test('clean tables get SET NOT NULL, one statement per table', async () => {
  const db = fakeDb();
  await findMigration().up(db);
  assert.equal(db.execs.length, MULTITENANT_TABLES.length);
  for (const table of MULTITENANT_TABLES) {
    assert.ok(
      db.execs.some(s => s.includes(`ALTER TABLE ${table}`) && /SET NOT NULL/.test(s)),
      `expected SET NOT NULL for ${table}`
    );
  }
});

test('a table with orphan rows is skipped, and does not block the others', async () => {
  const db = fakeDb({ orphansByTable: { kol_database: 42 } });
  await findMigration().up(db);
  assert.ok(
    !db.execs.some(s => s.includes('ALTER TABLE kol_database')),
    'table with NULL workspace_id rows must stay nullable'
  );
  assert.equal(db.execs.length, MULTITENANT_TABLES.length - 1, 'every other table is still constrained');
});

test('missing tables are skipped without throwing', async () => {
  const db = fakeDb({ missingTables: ['discovery_results'] });
  await findMigration().up(db);
  assert.ok(!db.execs.some(s => s.includes('ALTER TABLE discovery_results')));
});

test('re-running against already-constrained columns is tolerated', async () => {
  const db = fakeDb();
  db.exec = async () => { throw new Error('column "workspace_id" of relation "kols" already ... '); };
  await findMigration().up(db); // must not throw
});

test('an unexpected ALTER failure still propagates', async () => {
  const db = fakeDb();
  db.exec = async () => { throw new Error('permission denied for table kols'); };
  await assert.rejects(findMigration().up(db), /permission denied/);
});
