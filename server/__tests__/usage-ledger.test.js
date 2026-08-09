/**
 * Tests for the token/cost usage ledger (roadmap D5).
 *
 * Covers:
 *   - workspace isolation: the SQL always carries a workspace_id filter, and
 *     two workspaces never see each other's rows
 *   - month bucketing across a month boundary, in both driver shapes
 *     (SQLite text timestamps and pg Date objects)
 *   - the ?months= window (default, clamp, cutoff parameter) and ?agent= filter
 *   - dialect neutrality: no strftime / date_trunc / EXTRACT anywhere
 *   - the real statement executing on better-sqlite3, including against a row
 *     written with the column's CURRENT_TIMESTAMP default
 *   - the conductor plan route persisting its LLM cost
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const {
  getWorkspaceUsage, getPlatformUsage,
  monthKey, monthList, windowCutoff, normalizeMonths,
  DEFAULT_MONTHS, MAX_MONTHS,
} = require('../usage-ledger');
const { hasPermission } = require('../rbac');

/**
 * Fake driver over an in-memory row list. Applies the same filters the real
 * SQL would (workspace_id / started_at cutoff / agent_id), so a test that
 * seeds two workspaces genuinely exercises the isolation clause rather than
 * trusting it.
 */
function fakeDb(rows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    let i = 0;
    const wsFilter = /workspace_id = \?/.test(sql) ? params[i++] : null;
    const cutoff = params[i++];
    const agentFilter = /agent_id = \?/.test(sql) ? params[i++] : null;
    const out = rows.filter(r => {
      if (wsFilter && r.workspace_id !== wsFilter) return false;
      if (agentFilter && r.agent_id !== agentFilter) return false;
      const at = r.started_at instanceof Date
        ? r.started_at.toISOString().slice(0, 19).replace('T', ' ')
        : String(r.started_at).replace('T', ' ').slice(0, 19);
      return at >= cutoff;
    });
    return { rows: out };
  };
  return { db: { query }, calls };
}

const run = (o) => ({
  workspace_id: 'ws-1', agent_id: 'content-text',
  cost_usd_cents: 0, input_tokens: 0, output_tokens: 0, ...o,
});

// A fixed "now" so month arithmetic is deterministic. Mid-month on purpose.
const NOW = new Date('2026-08-09T12:00:00.000Z');

// ==================== Month bucketing ====================

test('monthKey buckets SQLite text timestamps by UTC month', () => {
  assert.equal(monthKey('2026-07-31 23:59:59'), '2026-07');
  assert.equal(monthKey('2026-08-01 00:00:00'), '2026-08');
  assert.equal(monthKey('2026-08-01T00:00:00.000Z'), '2026-08');
});

test('monthKey buckets pg Date objects by UTC month', () => {
  assert.equal(monthKey(new Date('2026-07-31T23:59:59.000Z')), '2026-07');
  assert.equal(monthKey(new Date('2026-08-01T00:00:00.000Z')), '2026-08');
});

test('monthKey does not let the local timezone move a row across the boundary', () => {
  // `new Date('2026-08-01 00:00:00')` parses as LOCAL time in Node, which in
  // any timezone west of UTC lands in July. The prefix slice must not care.
  assert.equal(monthKey('2026-08-01 00:00:00'), '2026-08');
  assert.equal(monthKey('2026-08-31 23:00:00'), '2026-08');
});

test('monthKey survives null / junk without throwing', () => {
  assert.equal(monthKey(null), null);
  assert.equal(monthKey(undefined), null);
  assert.equal(monthKey('not a date'), null);
  assert.equal(monthKey(new Date('nope')), null);
});

test('monthList walks back N-1 months from the current one, oldest first', () => {
  assert.deepEqual(
    monthList(6, NOW),
    ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']
  );
  assert.deepEqual(monthList(1, NOW), ['2026-08']);
});

test('monthList crosses the year boundary correctly', () => {
  assert.deepEqual(
    monthList(4, new Date('2026-02-14T00:00:00.000Z')),
    ['2025-11', '2025-12', '2026-01', '2026-02']
  );
});

test('windowCutoff is midnight UTC on the first of the oldest month, SQLite-shaped', () => {
  assert.equal(windowCutoff(6, NOW), '2026-03-01 00:00:00');
  assert.equal(windowCutoff(1, NOW), '2026-08-01 00:00:00');
  assert.match(windowCutoff(6, NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('aggregation splits runs across a month boundary', async () => {
  const { db } = fakeDb([
    run({ started_at: '2026-07-31 23:59:59', cost_usd_cents: 10, input_tokens: 100, output_tokens: 50 }),
    run({ started_at: '2026-08-01 00:00:00', cost_usd_cents: 20, input_tokens: 200, output_tokens: 60 }),
    run({ started_at: '2026-08-05 08:00:00', cost_usd_cents: 5, input_tokens: 10, output_tokens: 5 }),
  ]);
  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 6, now: NOW }, db);

  const july = r.byMonth.find(m => m.month === '2026-07');
  const august = r.byMonth.find(m => m.month === '2026-08');
  assert.equal(july.runs, 1);
  assert.equal(july.usd_cents, 10);
  assert.equal(august.runs, 2);
  assert.equal(august.usd_cents, 25);
  assert.equal(august.input_tokens, 210);
  assert.equal(august.output_tokens, 65);
  assert.equal(r.total.runs, 3);
  assert.equal(r.total.usd_cents, 35);
});

test('pg Date rows bucket identically to SQLite text rows', async () => {
  const asText = fakeDb([
    run({ started_at: '2026-07-31 23:00:00', cost_usd_cents: 7 }),
    run({ started_at: '2026-08-02 01:00:00', cost_usd_cents: 9 }),
  ]);
  const asDate = fakeDb([
    run({ started_at: new Date('2026-07-31T23:00:00.000Z'), cost_usd_cents: 7 }),
    run({ started_at: new Date('2026-08-02T01:00:00.000Z'), cost_usd_cents: 9 }),
  ]);
  const a = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, asText.db);
  const b = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, asDate.db);
  assert.deepEqual(a.byMonth, b.byMonth);
  assert.deepEqual(a.rows, b.rows);
});

test('every month in the window is present even with no runs', async () => {
  const { db } = fakeDb([]);
  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 3, now: NOW }, db);
  assert.deepEqual(r.byMonth.map(m => m.month), ['2026-06', '2026-07', '2026-08']);
  for (const m of r.byMonth) {
    assert.equal(m.runs, 0);
    assert.equal(m.usd_cents, 0);
  }
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.byAgent, []);
  assert.equal(r.total.runs, 0);
});

// ==================== Workspace isolation ====================

test('two workspaces do not see each other usage', async () => {
  const rows = [
    run({ workspace_id: 'ws-1', agent_id: 'strategy', started_at: '2026-08-01 10:00:00', cost_usd_cents: 100, input_tokens: 10, output_tokens: 1 }),
    run({ workspace_id: 'ws-2', agent_id: 'strategy', started_at: '2026-08-01 10:00:00', cost_usd_cents: 900, input_tokens: 90, output_tokens: 9 }),
    run({ workspace_id: 'ws-2', agent_id: 'ads', started_at: '2026-08-02 10:00:00', cost_usd_cents: 50 }),
  ];
  const one = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, fakeDb(rows).db);
  const two = await getWorkspaceUsage({ workspaceId: 'ws-2', now: NOW }, fakeDb(rows).db);

  assert.equal(one.total.runs, 1);
  assert.equal(one.total.usd_cents, 100);
  assert.deepEqual(one.byAgent.map(a => a.agent_id), ['strategy']);

  assert.equal(two.total.runs, 2);
  assert.equal(two.total.usd_cents, 950);
  assert.deepEqual(two.byAgent.map(a => a.agent_id), ['strategy', 'ads']);
});

test('the workspace query always filters on workspace_id', async () => {
  const { db, calls } = fakeDb([]);
  await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, db);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE workspace_id = \?/);
  assert.equal(calls[0].params[0], 'ws-1');
});

test('a missing workspaceId is a hard error, never an unscoped read', async () => {
  const { db } = fakeDb([]);
  await assert.rejects(
    () => getWorkspaceUsage({ workspaceId: '', now: NOW }, db),
    /requires a workspaceId/
  );
});

// ==================== Window + agent filter ====================

test('months defaults to 6 and clamps to [1, 24]', () => {
  assert.equal(normalizeMonths(undefined), DEFAULT_MONTHS);
  assert.equal(normalizeMonths(''), DEFAULT_MONTHS);
  assert.equal(normalizeMonths('banana'), DEFAULT_MONTHS);
  assert.equal(normalizeMonths('0'), DEFAULT_MONTHS);
  assert.equal(normalizeMonths('-3'), DEFAULT_MONTHS);
  assert.equal(normalizeMonths('3'), 3);
  assert.equal(normalizeMonths('9999'), MAX_MONTHS);
});

test('the months window excludes runs older than the cutoff', async () => {
  const rows = [
    run({ started_at: '2026-05-15 10:00:00', cost_usd_cents: 500 }),
    run({ started_at: '2026-08-01 10:00:00', cost_usd_cents: 20 }),
  ];
  const wide = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 6, now: NOW }, fakeDb(rows).db);
  const narrow = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 2, now: NOW }, fakeDb(rows).db);

  assert.equal(wide.total.runs, 2);
  assert.equal(wide.total.usd_cents, 520);
  assert.equal(narrow.total.runs, 1);
  assert.equal(narrow.total.usd_cents, 20);
  assert.equal(narrow.window.months, 2);
  assert.deepEqual(narrow.months, ['2026-07', '2026-08']);
});

test('the agent filter narrows the whole report, not just one column', async () => {
  const rows = [
    run({ agent_id: 'strategy', started_at: '2026-08-01 10:00:00', cost_usd_cents: 100 }),
    run({ agent_id: 'ads', started_at: '2026-08-01 11:00:00', cost_usd_cents: 40 }),
    run({ agent_id: 'ads', started_at: '2026-07-20 11:00:00', cost_usd_cents: 60 }),
  ];
  const all = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, fakeDb(rows).db);
  const adsOnly = await getWorkspaceUsage({ workspaceId: 'ws-1', agentId: 'ads', now: NOW }, fakeDb(rows).db);

  assert.equal(all.total.usd_cents, 200);
  assert.equal(adsOnly.total.usd_cents, 100);
  assert.equal(adsOnly.window.agent_id, 'ads');
  assert.deepEqual(adsOnly.byAgent.map(a => a.agent_id), ['ads']);
  assert.deepEqual(adsOnly.rows.map(r => `${r.month}/${r.agent_id}`), ['2026-07/ads', '2026-08/ads']);
});

test('the month × agent grid keeps both dimensions', async () => {
  const rows = [
    run({ agent_id: 'strategy', started_at: '2026-07-02 10:00:00', cost_usd_cents: 11, input_tokens: 5, output_tokens: 2 }),
    run({ agent_id: 'strategy', started_at: '2026-08-02 10:00:00', cost_usd_cents: 13 }),
    run({ agent_id: 'ads', started_at: '2026-08-03 10:00:00', cost_usd_cents: 17 }),
  ];
  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, fakeDb(rows).db);
  const cell = (m, a) => r.rows.find(x => x.month === m && x.agent_id === a);

  assert.equal(r.rows.length, 3);
  assert.equal(cell('2026-07', 'strategy').usd_cents, 11);
  assert.equal(cell('2026-07', 'strategy').input_tokens, 5);
  assert.equal(cell('2026-08', 'strategy').usd_cents, 13);
  assert.equal(cell('2026-08', 'ads').usd_cents, 17);
  assert.equal(cell('2026-07', 'ads'), undefined); // sparse: no run, no cell
  // byAgent is the agent marginal, ordered by spend
  assert.deepEqual(r.byAgent.map(a => [a.agent_id, a.usd_cents]), [['strategy', 24], ['ads', 17]]);
});

test('failed runs still count as calls and contribute their recorded cost', async () => {
  // The error path leaves cost/token columns at their DEFAULT 0, so a failed
  // run shows up in `runs` but adds nothing to spend — which is what the
  // schema actually stores, and the ledger must not pretend otherwise.
  const { db } = fakeDb([
    run({ started_at: '2026-08-01 10:00:00', cost_usd_cents: 0, input_tokens: 0, output_tokens: 0 }),
    run({ started_at: '2026-08-01 11:00:00', cost_usd_cents: 30, input_tokens: 3, output_tokens: 1 }),
  ]);
  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, db);
  assert.equal(r.total.runs, 2);
  assert.equal(r.total.usd_cents, 30);
});

test('a null agent_id lands in an "unknown" bucket rather than crashing', async () => {
  const { db } = fakeDb([run({ agent_id: null, started_at: '2026-08-01 10:00:00', cost_usd_cents: 4 })]);
  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', now: NOW }, db);
  assert.deepEqual(r.byAgent.map(a => a.agent_id), ['unknown']);
});

// ==================== Platform-admin view ====================

test('the platform view spans workspaces and breaks down by workspace', async () => {
  const rows = [
    run({ workspace_id: 'ws-1', agent_id: 'strategy', started_at: '2026-08-01 10:00:00', cost_usd_cents: 100 }),
    run({ workspace_id: 'ws-2', agent_id: 'strategy', started_at: '2026-08-01 10:00:00', cost_usd_cents: 900 }),
    run({ workspace_id: 'ws-2', agent_id: 'ads', started_at: '2026-07-01 10:00:00', cost_usd_cents: 50 }),
  ];
  const r = await getPlatformUsage({ now: NOW }, fakeDb(rows).db);
  assert.equal(r.total.runs, 3);
  assert.equal(r.total.usd_cents, 1050);
  assert.deepEqual(
    r.byWorkspace.map(w => [w.workspace_id, w.usd_cents]),
    [['ws-2', 950], ['ws-1', 100]]
  );
  assert.equal(r.byMonth.find(m => m.month === '2026-07').usd_cents, 50);
});

test('the platform query is intentionally NOT workspace-filtered', async () => {
  const { db, calls } = fakeDb([]);
  await getPlatformUsage({ now: NOW }, db);
  assert.ok(!/workspace_id = \?/.test(calls[0].sql), 'admin view reads across tenants by design');
  assert.match(calls[0].sql, /started_at >= \?/);
});

// ==================== Dialect neutrality ====================

test('the SQL uses no dialect-specific date functions', async () => {
  const { db, calls } = fakeDb([]);
  await getWorkspaceUsage({ workspaceId: 'ws-1', agentId: 'ads', now: NOW }, db);
  await getPlatformUsage({ now: NOW }, db);
  for (const { sql } of calls) {
    // strftime/date()/datetime() are SQLite-only; date_trunc/EXTRACT/INTERVAL
    // and ::casts are Postgres-only. Either kind 500s on the other driver.
    assert.ok(!/strftime|date_trunc|\bEXTRACT\s*\(|\bINTERVAL\b|::/i.test(sql), `dialect-specific SQL: ${sql}`);
    assert.ok(!/\bdatetime\s*\(|\bNOW\s*\(/i.test(sql), `dialect-specific SQL: ${sql}`);
  }
});

test('the cutoff is a bound parameter, never interpolated', async () => {
  const { db, calls } = fakeDb([]);
  await getWorkspaceUsage({ workspaceId: 'ws-1', months: 3, now: NOW }, db);
  const { sql, params } = calls[0];
  assert.match(sql, /started_at >= \?/);
  assert.ok(params.includes('2026-06-01 00:00:00'));
  assert.ok(!/2026-06-01/.test(sql), 'cutoff must not be baked into the SQL string');
});

// ==================== Route gating ====================

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// The route→permission wiring itself lives in rbac-routes.test.js (the
// canonical registry: 'GET /api/usage' → data.read, 'GET /api/admin/usage' →
// requirePlatformAdmin). What that file can't express is *why* viewers get in,
// and that the handler is actually scoped.

test('every role that can open Analytics can read its usage section', () => {
  // Usage is a read, and rbac.js documents viewer as "GET only — every read
  // route in a workspace". The Analytics page is already viewer-visible, so
  // gating usage higher would show a signed-in viewer a broken card.
  assert.ok(hasPermission('viewer', 'data.read'));
  assert.ok(hasPermission('editor', 'data.read'));
  assert.ok(hasPermission('admin', 'data.read'));
});

test('the workspace route reads through scoped(), not the bare query helper', () => {
  const handler = SRC.slice(SRC.indexOf('app.get(`${BASE_PATH}/api/usage`'));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /scoped\(req\.workspace\.id\)/);
  assert.match(body, /query: s\.query/);
});

// ==================== Conductor plan-build usage is recorded ====================

// ==================== Against the real SQLite driver ====================
//
// The tests above run on a fake driver, which proves the folding logic but not
// that the SQL actually executes. This one runs the real statement through
// better-sqlite3 against a real `agent_runs` table (schema copied from
// migrations.js), so the `?` placeholders, the `LIMIT ?`, and — most
// importantly — the string comparison between the JS cutoff and SQLite's
// `CURRENT_TIMESTAMP` layout are all exercised for real.

function sqliteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      agent_id TEXT NOT NULL,
      user_id TEXT,
      input TEXT,
      output TEXT,
      status TEXT DEFAULT 'running',
      error TEXT,
      cost_usd_cents INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )`);
  const insert = (row) => db.prepare(
    row.started_at
      ? 'INSERT INTO agent_runs (id, workspace_id, agent_id, cost_usd_cents, input_tokens, output_tokens, started_at) VALUES (?,?,?,?,?,?,?)'
      : 'INSERT INTO agent_runs (id, workspace_id, agent_id, cost_usd_cents, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)'
  ).run(...[
    uuidv4(), row.workspace_id, row.agent_id,
    row.cost_usd_cents || 0, row.input_tokens || 0, row.output_tokens || 0,
    ...(row.started_at ? [row.started_at] : []),
  ]);
  const query = async (sql, params = []) => ({ rows: db.prepare(sql).all(...params) });
  return { insert, query };
}

test('[sqlite] the statement executes and buckets real stored timestamps', async () => {
  const { insert, query } = sqliteDb();
  insert({ workspace_id: 'ws-1', agent_id: 'strategy', started_at: '2026-07-31 23:59:59', cost_usd_cents: 10, input_tokens: 100 });
  insert({ workspace_id: 'ws-1', agent_id: 'strategy', started_at: '2026-08-01 00:00:00', cost_usd_cents: 20, input_tokens: 200 });
  insert({ workspace_id: 'ws-1', agent_id: 'ads', started_at: '2026-08-15 06:30:00', cost_usd_cents: 5 });
  // Outside the 2-month window
  insert({ workspace_id: 'ws-1', agent_id: 'ads', started_at: '2026-01-15 06:30:00', cost_usd_cents: 999 });
  // Another tenant
  insert({ workspace_id: 'ws-2', agent_id: 'strategy', started_at: '2026-08-02 00:00:00', cost_usd_cents: 777 });

  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 2, now: NOW }, { query });

  assert.equal(r.total.runs, 3, 'the far-past run and the other tenant are both excluded');
  assert.equal(r.total.usd_cents, 35);
  assert.equal(r.byMonth.find(m => m.month === '2026-07').usd_cents, 10);
  assert.equal(r.byMonth.find(m => m.month === '2026-08').usd_cents, 25);
  assert.deepEqual(r.byAgent.map(a => a.agent_id), ['strategy', 'ads']);
});

test('[sqlite] a row written with the CURRENT_TIMESTAMP default lands in this month', async () => {
  // The real INSERTs in index.js never set started_at, so the column default is
  // the format the cutoff comparison actually has to match in production.
  const { insert, query } = sqliteDb();
  insert({ workspace_id: 'ws-1', agent_id: 'conductor', cost_usd_cents: 42, input_tokens: 7, output_tokens: 3 });

  const r = await getWorkspaceUsage({ workspaceId: 'ws-1', months: 1 }, { query });
  assert.equal(r.total.runs, 1, 'default-timestamp row must fall inside the current-month window');
  assert.equal(r.total.usd_cents, 42);
  assert.equal(r.byMonth[0].month, monthList(1)[0]);
  assert.equal(r.byMonth[0].usd_cents, 42);
});

test('[sqlite] the agent filter and the platform view both execute', async () => {
  const { insert, query } = sqliteDb();
  insert({ workspace_id: 'ws-1', agent_id: 'ads', started_at: '2026-08-01 10:00:00', cost_usd_cents: 11 });
  insert({ workspace_id: 'ws-2', agent_id: 'ads', started_at: '2026-08-01 10:00:00', cost_usd_cents: 22 });
  insert({ workspace_id: 'ws-2', agent_id: 'seo', started_at: '2026-08-01 10:00:00', cost_usd_cents: 33 });

  const filtered = await getWorkspaceUsage({ workspaceId: 'ws-2', agentId: 'ads', now: NOW }, { query });
  assert.equal(filtered.total.usd_cents, 22);

  const platform = await getPlatformUsage({ now: NOW }, { query });
  assert.equal(platform.total.usd_cents, 66);
  assert.deepEqual(platform.byWorkspace.map(w => w.workspace_id), ['ws-2', 'ws-1']);
});

// ==================== Conductor plan-build usage is recorded ====================

test('the conductor plan route persists its LLM cost into agent_runs', () => {
  // buildPlan returns { plan, cost } and the cost used to be echoed to the
  // client and dropped — invisible to the ledger. Regression guard.
  const route = SRC.slice(SRC.indexOf('app.post(`${BASE_PATH}/api/conductor/plan`'));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /INSERT INTO agent_runs/);
  assert.match(body, /'conductor'/);
  assert.match(body, /cost\?\.usdCents/);
  assert.match(body, /cost\?\.inputTokens/);
  assert.match(body, /cost\?\.outputTokens/);
});
