/**
 * Regression tests for the /api/discovery/batch-email cross-tenant fix.
 *
 * The route used to (a) dedupe against kol_database WITHOUT a workspace
 * filter, then (b) reuse the matched row's id in an INSERT OR REPLACE whose
 * column list omitted workspace_id — so workspace A's discovery run could
 * find workspace B's row and rewrite it with workspace_id = NULL, silently
 * ripping the row out of B's tenant.
 *
 * Like workspace-isolation.test.js, this exercises the *real SQL* the route
 * now runs (SQLite branch) against a real better-sqlite3 database — the
 * route itself needs a full HTTP + auth harness we don't have yet.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { assertContainsWorkspaceScope } = require('../database');

// The exact statements the fixed route runs (SQLite branch), minus dynamic
// timestamp defaults which the schema below provides.
const YT_DEDUPE_SQL =
  "SELECT id, email FROM kol_database WHERE workspace_id=? AND (profile_url=? OR (platform='youtube' AND username=?))";
const TT_DEDUPE_SQL =
  "SELECT id, email FROM kol_database WHERE workspace_id=? AND platform='tiktok' AND username=?";
const YT_UPSERT_SQL = `INSERT OR REPLACE INTO kol_database (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, total_videos, category, email, bio, country, language, scrape_status, source_campaign_id, updated_at)
  VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'complete', 'batch-email', CURRENT_TIMESTAMP)`;

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kol_database (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      profile_url TEXT NOT NULL,
      followers INTEGER DEFAULT 0,
      engagement_rate REAL DEFAULT 0,
      avg_views INTEGER DEFAULT 0,
      total_videos INTEGER DEFAULT 0,
      category TEXT,
      email TEXT,
      bio TEXT,
      country TEXT,
      language TEXT,
      scrape_status TEXT DEFAULT 'pending',
      source_campaign_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE discovery_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      campaign_id TEXT,
      search_criteria TEXT NOT NULL,
      status TEXT DEFAULT 'running'
    );
  `);
  return db;
}

const PROFILE_URL = 'https://www.youtube.com/channel/UC_shared';
const USERNAME = 'sharedcreator';

function seedVictimRow(db, wsB) {
  const victimId = uuidv4();
  db.prepare(
    `INSERT INTO kol_database (id, workspace_id, platform, username, profile_url, email, display_name)
     VALUES (?, ?, 'youtube', ?, ?, 'victim@b.com', 'B Creator')`
  ).run(victimId, wsB, USERNAME, PROFILE_URL);
  return victimId;
}

// Simulates the fixed route's dedupe + upsert flow for one YouTube channel.
function runBatchEmailFlow(db, workspaceId) {
  const existing = db.prepare(YT_DEDUPE_SQL).get(workspaceId, PROFILE_URL, USERNAME);
  if (existing?.email) return { action: 'skipped', id: existing.id };
  const kolId = existing?.id || uuidv4();
  db.prepare(YT_UPSERT_SQL).run(
    kolId, workspaceId, USERNAME, 'A Creator', '', PROFILE_URL,
    50000, 1000, 10, 'Gaming', 'found@a.com', 'bio', '', ''
  );
  return { action: 'saved', id: kolId };
}

test('dedupe lookup is workspace-scoped: A does not match B\'s row for the same profile_url', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();
  seedVictimRow(db, wsB);

  const fromA = db.prepare(YT_DEDUPE_SQL).get(wsA, PROFILE_URL, USERNAME);
  assert.equal(fromA, undefined, 'workspace A must not see workspace B\'s kol_database row');

  const fromB = db.prepare(YT_DEDUPE_SQL).get(wsB, PROFILE_URL, USERNAME);
  assert.ok(fromB, 'workspace B still finds its own row');
  assert.equal(fromB.email, 'victim@b.com');
});

test('tiktok dedupe lookup is workspace-scoped too', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();
  db.prepare(
    "INSERT INTO kol_database (id, workspace_id, platform, username, profile_url, email) VALUES (?, ?, 'tiktok', ?, ?, 'tt@b.com')"
  ).run(uuidv4(), wsB, 'ttuser', 'https://www.tiktok.com/@ttuser');

  assert.equal(db.prepare(TT_DEDUPE_SQL).get(wsA, 'ttuser'), undefined);
  assert.ok(db.prepare(TT_DEDUPE_SQL).get(wsB, 'ttuser'));
});

test('A\'s flow neither reads nor overwrites B\'s row — it creates a separate row in A', () => {
  const db = setupDb();
  const wsA = uuidv4(), wsB = uuidv4();
  const victimId = seedVictimRow(db, wsB);

  const result = runBatchEmailFlow(db, wsA);
  assert.equal(result.action, 'saved');
  assert.notEqual(result.id, victimId, 'must never reuse a row id from another workspace');

  // B's row is byte-for-byte intact (workspace_id, email, name untouched)
  const victim = db.prepare('SELECT * FROM kol_database WHERE id = ?').get(victimId);
  assert.equal(victim.workspace_id, wsB, 'victim row must keep its workspace_id (the old INSERT OR REPLACE NULLed it)');
  assert.equal(victim.email, 'victim@b.com');
  assert.equal(victim.display_name, 'B Creator');

  // A got its own row, correctly stamped with A's workspace_id
  const mine = db.prepare('SELECT * FROM kol_database WHERE id = ?').get(result.id);
  assert.equal(mine.workspace_id, wsA);
  assert.equal(mine.email, 'found@a.com');
});

test('re-running A\'s flow reuses A\'s own row and keeps workspace_id set (REPLACE includes the column)', () => {
  const db = setupDb();
  const wsA = uuidv4();

  const first = runBatchEmailFlow(db, wsA);
  assert.equal(first.action, 'saved');

  // Second run: dedupe finds A's row (it has an email) and skips
  const second = runBatchEmailFlow(db, wsA);
  assert.equal(second.action, 'skipped');
  assert.equal(second.id, first.id);

  // Force the REPLACE path (row exists but without email) and verify
  // workspace_id survives the whole-row rewrite.
  db.prepare('UPDATE kol_database SET email = NULL WHERE id = ?').run(first.id);
  const third = runBatchEmailFlow(db, wsA);
  assert.equal(third.action, 'saved');
  assert.equal(third.id, first.id, 'same-workspace row id is reused');
  const row = db.prepare('SELECT workspace_id, email FROM kol_database WHERE id = ?').get(first.id);
  assert.equal(row.workspace_id, wsA, 'workspace_id must survive INSERT OR REPLACE');
  assert.equal(row.email, 'found@a.com');
});

test('route source: batch-email statements all carry workspace_id', () => {
  // Source-level guard: the monolith has no route-level test harness, so pin
  // the three statements that caused the leak to their scoped form.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const routeStart = src.indexOf('/api/discovery/batch-email');
  assert.ok(routeStart > 0, 'batch-email route exists');
  const routeSrc = src.slice(routeStart, src.indexOf('detectCategoryForDiscovery(text)', routeStart));

  // discovery_jobs insert sets workspace_id
  assert.match(routeSrc, /INSERT INTO discovery_jobs \(id, workspace_id, campaign_id/);
  // Both dedupe lookups are scoped
  const dedupes = routeSrc.match(/SELECT id, email FROM kol_database WHERE [^"]+/g) || [];
  assert.ok(dedupes.length >= 2, 'expected two dedupe lookups');
  for (const d of dedupes) assert.match(d, /workspace_id=\?/);
  // Every kol_database upsert's column list includes workspace_id
  const upserts = routeSrc.match(/INSERT (OR REPLACE )?INTO kol_database \([^)]+\)/g) || [];
  assert.ok(upserts.length >= 4, 'expected four upsert branches (yt/tt × pg/sqlite)');
  for (const u of upserts) assert.match(u, /\(id, workspace_id,/);
});

test('the fixed SQL passes the runtime workspace-scope lint', () => {
  for (const sql of [YT_DEDUPE_SQL, TT_DEDUPE_SQL, YT_UPSERT_SQL]) {
    assert.equal(assertContainsWorkspaceScope(sql).ok, true, sql.slice(0, 60));
  }
});
