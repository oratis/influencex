/**
 * Multi-tenancy migration tests.
 *
 * Uses an in-memory SQLite DB (better-sqlite3) per test so the tests are
 * isolated and deterministic. Exercises the real migration code against
 * schema + data fixtures representing three scenarios:
 *
 *   1. Fresh install (no users, no data)
 *   2. Upgrade from v1 with one user + their data
 *   3. Upgrade from v1 with multiple users + shared data
 *
 * The migration also needs to be **idempotent** — running it twice should
 * produce the same result as running it once.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runPendingMigrations, MIGRATIONS } = require('../migrations');

// The SQLite schema we want to populate before running migrations.
// This mirrors what database.js creates — but stripped down to the tables
// we care about for the migration tests.
const BASE_SCHEMA_V1 = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active'
  );

  CREATE TABLE kols (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    username TEXT NOT NULL,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    kol_id TEXT,
    campaign_id TEXT,
    status TEXT DEFAULT 'draft'
  );

  CREATE TABLE pipeline_jobs (
    id TEXT PRIMARY KEY,
    campaign_id TEXT
  );

  CREATE TABLE kol_database (
    id TEXT PRIMARY KEY,
    username TEXT
  );

  CREATE TABLE content_data (
    id TEXT PRIMARY KEY,
    platform TEXT
  );

  CREATE TABLE registration_data (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL
  );

  CREATE TABLE content_scrape_cache (
    id TEXT PRIMARY KEY,
    content_url TEXT UNIQUE NOT NULL
  );

  CREATE TABLE content_daily_stats (
    id TEXT PRIMARY KEY,
    content_url TEXT NOT NULL,
    stat_date TEXT NOT NULL
  );

  CREATE TABLE dashboard_events (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    label TEXT NOT NULL
  );

  CREATE TABLE discovery_jobs (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE discovery_results (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL
  );

  CREATE TABLE email_replies (
    id TEXT PRIMARY KEY
  );

  -- The v2 schema would also include these but we test that the migration
  -- correctly creates workspaces / workspace_members even when absent.
`;

// Build a db API matching what runPendingMigrations expects.
function makeDbApi(db) {
  return {
    query: async (sql, params = []) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
        return { rows: db.prepare(sql).all(...params) };
      }
      const info = db.prepare(sql).run(...params);
      return { rows: [], rowCount: info.changes };
    },
    queryOne: async (sql, params = []) => db.prepare(sql).get(...params),
    exec: async (sql, params = []) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        return db.prepare(sql).all(...params);
      }
      try {
        const info = db.prepare(sql).run(...params);
        return { rowCount: info.changes };
      } catch (e) {
        // Multi-statement exec (like CREATE TABLE; CREATE INDEX;) — fall through to db.exec
        if (/multiple statements/i.test(e.message)) {
          db.exec(sql);
          return { rowCount: 0 };
        }
        throw e;
      }
    },
  };
}

function setupDb() {
  const db = new Database(':memory:');
  db.exec(BASE_SCHEMA_V1);
  // Simulate the workspaces + workspace_members tables that would normally
  // come from database.js init — the multi-tenancy migration assumes they
  // exist, so we create them here.
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      owner_user_id TEXT NOT NULL,
      plan TEXT DEFAULT 'starter',
      settings TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      invited_by TEXT,
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
  return db;
}

function runMigrations(db) {
  return runPendingMigrations(makeDbApi(db));
}

function count(db, sql, ...params) {
  return db.prepare(`SELECT COUNT(*) as c FROM (${sql})`).get(...params).c;
}

// ============================================================================

test('fresh install: migrations succeed with no users and no data', async () => {
  const db = setupDb();
  const result = await runMigrations(db);
  assert.ok(result.applied >= 1, 'at least one migration should apply on fresh DB');
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspace_members').get().c, 0);
});

test('fresh install: workspace_id column added to all 13 business tables', async () => {
  const db = setupDb();
  await runMigrations(db);
  const tables = ['campaigns', 'kols', 'contacts', 'pipeline_jobs', 'kol_database',
    'content_data', 'registration_data', 'content_scrape_cache',
    'content_daily_stats', 'dashboard_events', 'discovery_jobs',
    'discovery_results', 'email_replies'];
  for (const t of tables) {
    const info = db.pragma(`table_info(${t})`);
    const hasCol = info.some(c => c.name === 'workspace_id');
    assert.ok(hasCol, `${t} should have workspace_id column`);
  }
});

test('upgrade: single user with campaign + kols backfilled into their workspace', async () => {
  const db = setupDb();
  // v1 data
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('user_1', 'oratis@hakko.ai', 'hash', 'Oratis', 'admin');
  // Note: campaigns doesn't have workspace_id yet — it's added by the migration
  db.prepare("INSERT INTO campaigns (id, name) VALUES (?, ?)").run('camp_1', 'Q1 push');
  db.prepare("INSERT INTO kols (id, campaign_id, username) VALUES (?, ?, ?)").run('kol_1', 'camp_1', 'alice');
  db.prepare("INSERT INTO kols (id, campaign_id, username) VALUES (?, ?, ?)").run('kol_2', 'camp_1', 'bob');

  await runMigrations(db);

  // One workspace created for the user
  const workspaces = db.prepare('SELECT * FROM workspaces').all();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].owner_user_id, 'user_1');

  // Membership for that user as admin
  const member = db.prepare('SELECT * FROM workspace_members WHERE user_id = ?').get('user_1');
  assert.equal(member.role, 'admin');
  assert.equal(member.workspace_id, workspaces[0].id);

  // Every orphan row got a workspace_id (one Legacy workspace + everything moved to it)
  const orphanCampaigns = db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE workspace_id IS NULL').get().c;
  const orphanKols = db.prepare('SELECT COUNT(*) as c FROM kols WHERE workspace_id IS NULL').get().c;
  assert.equal(orphanCampaigns, 0);
  assert.equal(orphanKols, 0);

  // KOLs inherit workspace from their parent campaign
  const kolRows = db.prepare('SELECT campaign_id, workspace_id FROM kols').all();
  const campRow = db.prepare('SELECT workspace_id FROM campaigns WHERE id = ?').get('camp_1');
  for (const k of kolRows) {
    assert.equal(k.workspace_id, campRow.workspace_id, 'kol should inherit campaign workspace');
  }
});

test('upgrade: single-user orphan data goes to that user\'s workspace, not Legacy', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('user_1', 'a@b.com', 'x', 'A', 'admin');
  db.prepare("INSERT INTO kol_database (id, username) VALUES (?, ?)").run('k1', 'alice');
  db.prepare("INSERT INTO kol_database (id, username) VALUES (?, ?)").run('k2', 'bob');

  await runMigrations(db);

  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c, 1,
    'should have exactly 1 workspace (the user\'s) — no Legacy for single-user installs');
  const userWs = db.prepare('SELECT id FROM workspaces WHERE owner_user_id = ?').get('user_1');
  const rows = db.prepare('SELECT workspace_id FROM kol_database').all();
  for (const r of rows) {
    assert.equal(r.workspace_id, userWs.id);
  }
});

test('upgrade: multi-user orphan data falls back to Legacy workspace with all users as members', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u1', 'a@b.com', 'x', 'Alice', 'admin');
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u2', 'b@b.com', 'x', 'Bob', 'member');
  db.prepare("INSERT INTO kol_database (id, username) VALUES (?, ?)").run('k1', 'alice');

  await runMigrations(db);

  const legacy = db.prepare("SELECT * FROM workspaces WHERE slug = 'legacy'").get();
  assert.ok(legacy, 'legacy workspace should exist');
  const orphan = db.prepare('SELECT workspace_id FROM kol_database').get();
  assert.equal(orphan.workspace_id, legacy.id);
  // Both users should be members of Legacy
  const legacyMembers = db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?')
    .all(legacy.id).map(r => r.user_id).sort();
  assert.deepEqual(legacyMembers, ['u1', 'u2']);
});

test('idempotency: running migrations twice produces identical state', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('user_1', 'a@b.com', 'x', 'A', 'admin');
  db.prepare("INSERT INTO campaigns (id, name) VALUES (?, ?)").run('c1', 'C');

  await runMigrations(db);
  const wsCount1 = db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c;
  const memberCount1 = db.prepare('SELECT COUNT(*) as c FROM workspace_members').get().c;

  // Second run — must be a no-op per the schema_migrations tracker
  const secondResult = await runMigrations(db);
  assert.equal(secondResult.applied, 0, 'second run should apply 0 migrations');

  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c, wsCount1);
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspace_members').get().c, memberCount1);
});

test('multiple users each get their own workspace', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u1', 'a@b.com', 'x', 'Alice', 'admin');
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u2', 'b@b.com', 'x', 'Bob', 'member');
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u3', 'c@b.com', 'x', 'Carol', 'viewer');

  await runMigrations(db);

  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c, 3);
  for (const uid of ['u1', 'u2', 'u3']) {
    const m = db.prepare('SELECT * FROM workspace_members WHERE user_id = ?').get(uid);
    assert.ok(m, `user ${uid} must have a workspace membership`);
    assert.equal(m.role, 'admin', 'all users become admin of their own workspace');
  }
});

test('workspace slug is unique even for users with similar names', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u1', 'a@b.com', 'x', 'Alice', 'admin');
  db.prepare("INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)")
    .run('u2', 'b@b.com', 'x', 'Alice', 'member');

  await runMigrations(db);

  const slugs = db.prepare('SELECT slug FROM workspaces').all().map(r => r.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'all slugs must be unique');
});

test('migration tracked in schema_migrations', async () => {
  const db = setupDb();
  await runMigrations(db);
  const row = db.prepare("SELECT * FROM schema_migrations WHERE id = '2026-04-18-multitenancy-init'").get();
  assert.ok(row);
  assert.ok(row.applied_at);
});

test('no users + orphan rows: legacy workspace not created (would have no owner)', async () => {
  const db = setupDb();
  db.prepare("INSERT INTO campaigns (id, name) VALUES (?, ?)").run('c1', 'C');
  await runMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c, 0);
  // Row is still orphaned — that's acceptable since there's no valid owner
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE workspace_id IS NULL').get().c, 1);
});
