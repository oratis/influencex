/**
 * Integration tests for the inbox_messages migration + workspace-scope lint.
 * We don't spin up express — instead we verify the schema exists after
 * migration and confirm the SQL our endpoints emit passes the scope lint.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { MIGRATIONS } = require('../migrations');
const { assertContainsWorkspaceScope } = require('../database');

function makeSqliteDbApi() {
  const db = new Database(':memory:');
  const query = async (sql, params = []) => ({ rows: db.prepare(sql).all(...params) });
  const queryOne = async (sql, params = []) => db.prepare(sql).get(...params) || null;
  const exec = async (sql, params = []) => {
    const info = db.prepare(sql).run(...params);
    return { rowCount: info.changes };
  };
  return { db, query, queryOne, exec };
}

function applyInboxMigration(api) {
  const mig = MIGRATIONS.find(m => m.id === '2026-04-22-inbox-messages');
  assert.ok(mig, 'inbox-messages migration not found');
  return mig.up(api);
}

test('migration creates inbox_messages with expected columns', async () => {
  const api = makeSqliteDbApi();
  await applyInboxMigration(api);

  const cols = api.db.prepare("PRAGMA table_info(inbox_messages)").all().map(c => c.name);
  for (const expected of [
    'id', 'workspace_id', 'platform', 'kind', 'external_id', 'thread_id',
    'author_handle', 'text', 'sentiment', 'priority', 'status',
    'draft_reply', 'replied_at', 'occurred_at', 'tags', 'raw',
  ]) {
    assert.ok(cols.includes(expected), `inbox_messages missing column: ${expected}`);
  }

  const indexes = api.db.prepare("PRAGMA index_list(inbox_messages)").all().map(i => i.name);
  assert.ok(indexes.some(n => /idx_inbox_messages_ext/.test(n)), 'missing unique ext index');
});

test('migration is idempotent — calling twice is safe', async () => {
  const api = makeSqliteDbApi();
  await applyInboxMigration(api);
  // Second call must not throw
  await applyInboxMigration(api);
  const count = api.db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE name='inbox_messages'").get().c;
  assert.equal(count, 1);
});

test('unique (workspace_id, platform, external_id) prevents duplicate mentions', async () => {
  const api = makeSqliteDbApi();
  await applyInboxMigration(api);
  api.db.prepare('INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id) VALUES (?,?,?,?,?)')
    .run('row-1', 'ws-1', 'twitter', 'mention', 'ext-1');
  assert.throws(
    () => api.db.prepare('INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id) VALUES (?,?,?,?,?)')
      .run('row-2', 'ws-1', 'twitter', 'mention', 'ext-1'),
    /UNIQUE/
  );
  // Different workspace — allowed.
  api.db.prepare('INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id) VALUES (?,?,?,?,?)')
    .run('row-3', 'ws-2', 'twitter', 'mention', 'ext-1');
});

test('inbox list + patch SQL passes the workspace-scope lint', () => {
  const listSql = `SELECT id, platform FROM inbox_messages WHERE workspace_id = ? AND status = ? ORDER BY occurred_at DESC LIMIT ? OFFSET ?`;
  const updateSql = `UPDATE inbox_messages SET status = ? WHERE id = ? AND workspace_id = ?`;
  assert.equal(assertContainsWorkspaceScope(listSql).ok, true);
  assert.equal(assertContainsWorkspaceScope(updateSql).ok, true);
});
