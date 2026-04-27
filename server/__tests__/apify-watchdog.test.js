const { test } = require('node:test');
const assert = require('node:assert/strict');

const watchdog = require('../apify-watchdog');

function makeDb(rows) {
  const updates = [];
  return {
    db: {
      query: async (sql, params) => ({ rows }),
      exec: async (sql, params) => { updates.push({ sql, params }); },
    },
    updates,
  };
}

test('reapStuckRuns: marks running rows older than threshold as timeout', async () => {
  const stuck = [{ id: 'r1' }, { id: 'r2' }];
  const { db, updates } = makeDb(stuck);
  const r = await watchdog.reapStuckRuns(db);
  assert.equal(r.reaped, 2);
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /UPDATE apify_runs SET status='timeout'/);
  assert.equal(updates[0].params[1], 'r1');
});

test('reapStuckRuns: zero reaped when nothing stuck', async () => {
  const { db, updates } = makeDb([]);
  const r = await watchdog.reapStuckRuns(db);
  assert.equal(r.reaped, 0);
  assert.equal(updates.length, 0);
});

test('listRecentRuns: returns rows from query', async () => {
  const sample = [{ id: 'r1', status: 'failed' }, { id: 'r2', status: 'failed' }];
  const db = { query: async () => ({ rows: sample }) };
  const r = await watchdog.listRecentRuns(db, { status: 'failed', limit: 50 });
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'r1');
});

test('listRecentRuns: returns empty on db error', async () => {
  const db = { query: async () => { throw new Error('connection refused'); } };
  const r = await watchdog.listRecentRuns(db);
  assert.deepEqual(r, []);
});
