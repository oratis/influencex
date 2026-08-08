/**
 * Schema-contract regression tests.
 *
 * The pipeline approve endpoint and the Cmd-K cross-entity search shipped
 * SQL referencing columns that don't exist on `contacts` (`kol_email`,
 * `kol_username`, `updated_at`). The approve statement 500'd every call and
 * left the pipeline job stranded in `stage='send'`; the search error was
 * swallowed by `.catch(() => [])` so contact search silently returned [].
 *
 * These tests execute the exact statement shapes those routes use against
 * the fully-migrated real schema, so a phantom column can never ship
 * silently again. They also pin the runPipeline → kol_database write to
 * carry workspace_id (rows with NULL workspace_id are invisible to every
 * workspace-scoped read).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, exec, initializeDatabase } = require('../database');
const { runPendingMigrations } = require('../migrations');

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

test('approve-endpoint contact UPDATE uses only real contacts columns', async () => {
  // Same statement shape as POST /api/pipeline/jobs/:id/approve. No row
  // matches the random id — we only care that the SQL compiles against the
  // real schema (a phantom column throws before row matching happens).
  await exec(
    "UPDATE contacts SET status='pending', send_error=NULL, email_subject=?, email_body=? WHERE id=? AND workspace_id=?",
    ['s', 'b', uuidv4(), uuidv4()]
  );
});

test('contacts has no kol_email column (canary for the approve bug)', async () => {
  // If someone adds contacts.kol_email later, this canary fails on purpose:
  // revisit the approve endpoint + search JOIN, then update this test.
  await assert.rejects(
    exec('UPDATE contacts SET kol_email=? WHERE id=?', ['x', uuidv4()]),
    /kol_email/
  );
});

test('Cmd-K contact search SQL executes against the real schema', async () => {
  const like = '%nope%';
  const res = await query(
    `SELECT c.id, c.kol_id, k.username AS kol_username, k.email AS kol_email, c.status, c.campaign_id
     FROM contacts c
     JOIN kols k ON k.id = c.kol_id AND k.workspace_id = c.workspace_id
     WHERE c.workspace_id = ?
       AND (LOWER(k.username) LIKE LOWER(?) OR LOWER(k.email) LIKE LOWER(?) OR LOWER(k.display_name) LIKE LOWER(?))
     ORDER BY c.created_at DESC
     LIMIT ?`,
    [uuidv4(), like, like, like, 5]
  );
  assert.ok(Array.isArray(res.rows));
});

test('runPipeline kol_database write carries workspace_id and upserts by (ws, platform, username)', async () => {
  const wsId = uuidv4();
  const username = `contract-test-${uuidv4().slice(0, 8)}`;
  const insert = async (kolId, followers) => exec(
    `INSERT OR REPLACE INTO kol_database (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, following, engagement_rate, avg_views, total_videos, category, email, bio, country, language, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, CURRENT_TIMESTAMP)`,
    [kolId, wsId, 'youtube', username, username, '', `https://youtube.com/@${username}`, followers, 0, 0, 0, 0, '', '', '', '', '', 50, 'r', 10, null]
  );

  try {
    // First run: fresh row, must land with workspace_id set.
    const firstId = uuidv4();
    await insert(firstId, 100);
    const row = await queryOne(
      'SELECT id, workspace_id, followers FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
      [wsId, 'youtube', username]
    );
    assert.ok(row, 'row must be visible via workspace-scoped read');
    assert.equal(row.workspace_id, wsId);

    // Second run mimics runPipeline's dedupe: reuse the existing row id.
    const existing = await queryOne(
      'SELECT id FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
      [wsId, 'youtube', username]
    );
    await insert(existing.id, 200);
    const rows = await query(
      'SELECT id, followers FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
      [wsId, 'youtube', username]
    );
    assert.equal(rows.rows.length, 1, 'second run must update, not duplicate');
    assert.equal(rows.rows[0].followers, 200);
  } finally {
    await exec('DELETE FROM kol_database WHERE workspace_id = ?', [wsId]);
  }
});
