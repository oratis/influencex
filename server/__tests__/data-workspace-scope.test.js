/**
 * Regression tests for the /api/data/* workspace-scoping fix.
 *
 * The content_data / registration_data / content_daily_stats handlers used to
 * run bare, unscoped SQL: every workspace saw (and could overwrite) every
 * other workspace's rows. These tests pin the fixed SQL shapes — INSERTs set
 * workspace_id, SELECTs filter by it, and client-supplied upsert ids can no
 * longer address another tenant's row.
 *
 * Same approach as workspace-isolation.test.js: real SQL against a real
 * better-sqlite3 database (SQLite branch of the dual-dialect statements).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const { assertContainsWorkspaceScope } = require('../database');

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content_data (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      kol_name TEXT,
      platform TEXT,
      content_title TEXT,
      content_url TEXT,
      publish_date TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0
    );
    CREATE TABLE registration_data (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      date TEXT NOT NULL,
      registrations INTEGER DEFAULT 0,
      source TEXT
    );
    CREATE TABLE content_daily_stats (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      content_url TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      source TEXT DEFAULT 'scrape',
      UNIQUE(content_url, stat_date)
    );
  `);
  return db;
}

// The statements the fixed handlers run (SQLite branch).
const CONTENT_INSERT_SQL =
  'INSERT OR REPLACE INTO content_data (id, workspace_id, kol_name, platform, content_title, content_url, publish_date, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const CONTENT_SELECT_SQL =
  'SELECT * FROM content_data WHERE workspace_id = ? ORDER BY publish_date DESC';
const REG_INSERT_SQL =
  'INSERT OR REPLACE INTO registration_data (id, workspace_id, date, registrations, source) VALUES (?, ?, ?, ?, ?)';
const REG_SELECT_SQL =
  'SELECT * FROM registration_data WHERE workspace_id = ? ORDER BY date ASC';
const DAILY_INSERT_SQL =
  'INSERT OR REPLACE INTO content_daily_stats (id, workspace_id, content_url, stat_date, views, likes, comments, shares, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Mirror of safeUpsertId() in server/index.js.
function safeUpsertId(db, table, itemId, workspaceId) {
  if (!itemId) return uuidv4();
  const owner = db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(itemId);
  if (owner && owner.workspace_id !== workspaceId) return uuidv4();
  return itemId;
}

// Mirror of upsertContentDailyStat() in server/index.js (SQLite branch).
function upsertDailyStat(db, workspaceId, contentUrl, statDate, stats, source) {
  const existing = db.prepare(
    'SELECT workspace_id FROM content_daily_stats WHERE content_url = ? AND stat_date = ?'
  ).get(contentUrl, statDate);
  if (existing && existing.workspace_id && existing.workspace_id !== workspaceId) return false;
  db.prepare(DAILY_INSERT_SQL).run(
    uuidv4(), workspaceId, contentUrl, statDate,
    stats.views, stats.likes, stats.comments, stats.shares, source
  );
  return true;
}

test('content_data insert sets workspace_id; scoped select isolates workspaces', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();

  db.prepare(CONTENT_INSERT_SQL).run(uuidv4(), wsA, 'creatorA', 'youtube', 'A video', 'https://y.t/a', '2026-08-01', 10, 1, 0, 0);
  db.prepare(CONTENT_INSERT_SQL).run(uuidv4(), wsB, 'creatorB', 'tiktok', 'B video', 'https://t.t/b', '2026-08-02', 20, 2, 0, 0);
  // Legacy pre-multitenancy row: NULL workspace_id → invisible to everyone
  db.prepare("INSERT INTO content_data (id, kol_name, platform, content_title) VALUES (?, 'legacy', 'youtube', 'orphan')").run(uuidv4());

  const forA = db.prepare(CONTENT_SELECT_SQL).all(wsA);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].kol_name, 'creatorA');
  assert.equal(forA[0].workspace_id, wsA, 'insert must stamp workspace_id');

  const forB = db.prepare(CONTENT_SELECT_SQL).all(wsB);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].kol_name, 'creatorB');
});

test('registration_data insert sets workspace_id; scoped select isolates workspaces', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();

  db.prepare(REG_INSERT_SQL).run(uuidv4(), wsA, '2026-08-01', 5, 'organic');
  db.prepare(REG_INSERT_SQL).run(uuidv4(), wsB, '2026-08-01', 500, 'ads');

  const forA = db.prepare(REG_SELECT_SQL).all(wsA);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].registrations, 5);
  assert.equal(forA[0].workspace_id, wsA, 'insert must stamp workspace_id');
});

test('client-supplied upsert id cannot rewrite another workspace\'s content row', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();
  const victimId = uuidv4();
  db.prepare(CONTENT_INSERT_SQL).run(victimId, wsB, 'creatorB', 'tiktok', 'B video', 'https://t.t/b', '2026-08-02', 20, 2, 0, 0);

  // Attacker in workspace A posts an item claiming B's row id
  const id = safeUpsertId(db, 'content_data', victimId, wsA);
  assert.notEqual(id, victimId, 'must mint a fresh id instead of touching B\'s row');
  db.prepare(CONTENT_INSERT_SQL).run(id, wsA, 'creatorA', 'youtube', 'A video', 'https://y.t/a', '2026-08-01', 1, 0, 0, 0);

  const victim = db.prepare('SELECT * FROM content_data WHERE id = ?').get(victimId);
  assert.equal(victim.workspace_id, wsB, 'B\'s row keeps its workspace_id');
  assert.equal(victim.kol_name, 'creatorB', 'B\'s row content untouched');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM content_data').get().c, 2);
});

test('same-workspace upsert id is reused (update semantics preserved)', () => {
  const db = setupDb();
  const wsA = uuidv4();
  const myId = uuidv4();
  db.prepare(CONTENT_INSERT_SQL).run(myId, wsA, 'creatorA', 'youtube', 'v1', 'https://y.t/a', '2026-08-01', 1, 0, 0, 0);

  const id = safeUpsertId(db, 'content_data', myId, wsA);
  assert.equal(id, myId);
  db.prepare(CONTENT_INSERT_SQL).run(id, wsA, 'creatorA', 'youtube', 'v2', 'https://y.t/a', '2026-08-01', 99, 0, 0, 0);

  const row = db.prepare('SELECT * FROM content_data WHERE id = ?').get(myId);
  assert.equal(row.content_title, 'v2');
  assert.equal(row.views, 99);
  assert.equal(row.workspace_id, wsA, 'workspace_id survives the REPLACE');
});

test('daily-stat upsert fails closed when the (url, date) slot belongs to another workspace', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();
  const url = 'https://y.t/shared', date = '2026-08-08';

  assert.equal(upsertDailyStat(db, wsB, url, date, { views: 100, likes: 5, comments: 1, shares: 0 }, 'scrape'), true);
  // A tries the same slot — the global UNIQUE(content_url, stat_date) means a
  // write would REPLACE B's row, so the helper must refuse.
  assert.equal(upsertDailyStat(db, wsA, url, date, { views: 1, likes: 0, comments: 0, shares: 0 }, 'manual'), false);

  const row = db.prepare('SELECT * FROM content_daily_stats WHERE content_url = ? AND stat_date = ?').get(url, date);
  assert.equal(row.workspace_id, wsB);
  assert.equal(row.views, 100, 'B\'s snapshot untouched');
});

test('daily-stat upsert adopts legacy NULL-workspace rows and updates its own', () => {
  const db = setupDb();
  const wsA = uuidv4();
  const url = 'https://y.t/mine', date = '2026-08-08';
  // Legacy row from before the fix
  db.prepare("INSERT INTO content_daily_stats (id, content_url, stat_date, views) VALUES (?, ?, ?, 7)").run(uuidv4(), url, date);

  assert.equal(upsertDailyStat(db, wsA, url, date, { views: 8, likes: 0, comments: 0, shares: 0 }, 'scrape'), true);
  const row = db.prepare('SELECT * FROM content_daily_stats WHERE content_url = ? AND stat_date = ?').get(url, date);
  assert.equal(row.workspace_id, wsA, 'legacy row adopted by the writing workspace');
  assert.equal(row.views, 8);

  // Second write from the same workspace updates in place
  assert.equal(upsertDailyStat(db, wsA, url, date, { views: 9, likes: 0, comments: 0, shares: 0 }, 'scrape'), true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM content_daily_stats').get().c, 1);
  assert.equal(db.prepare('SELECT views FROM content_daily_stats WHERE content_url = ?').get(url).views, 9);
});

test('the fixed /api/data SQL passes the runtime workspace-scope lint', () => {
  for (const sql of [CONTENT_INSERT_SQL, CONTENT_SELECT_SQL, REG_INSERT_SQL, REG_SELECT_SQL, DAILY_INSERT_SQL]) {
    assert.equal(assertContainsWorkspaceScope(sql).ok, true, sql.slice(0, 60));
  }
});
