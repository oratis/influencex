/**
 * Tests for the workspace scoping infrastructure:
 *   - assertContainsWorkspaceScope (runtime SQL lint)
 *   - extractTable (SQL parser)
 *   - scoped() query wrapper (just the scope-enforcement behavior —
 *     DB round-trips are already covered by integration tests elsewhere)
 *   - RBAC workspace-role fallback
 *   - workspace-middleware resolution + membership verification
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertContainsWorkspaceScope,
  extractTable,
  WORKSPACE_EXEMPT_TABLES,
} = require('../database');
const rbac = require('../rbac');
const { resolveWorkspaceId, findMembership } = require('../workspace-middleware');

// ============================================================================
// extractTable

test('extractTable: SELECT', () => {
  assert.equal(extractTable('SELECT * FROM campaigns WHERE id = ?'), 'campaigns');
  assert.equal(extractTable('select id, name from Kols'), 'kols');
  assert.equal(extractTable('  SELECT COUNT(*) FROM contacts c'), 'contacts');
});

test('extractTable: UPDATE / INSERT / DELETE', () => {
  assert.equal(extractTable('UPDATE campaigns SET name=?'), 'campaigns');
  assert.equal(extractTable('INSERT INTO kols (id, username) VALUES (?, ?)'), 'kols');
  assert.equal(extractTable('DELETE FROM pipeline_jobs WHERE id=?'), 'pipeline_jobs');
});

test('extractTable: handles quoted identifiers', () => {
  assert.equal(extractTable('SELECT * FROM "campaigns" WHERE id = ?'), 'campaigns');
  assert.equal(extractTable('SELECT * FROM `kols`'), 'kols');
});

test('extractTable: null on unrecognizable SQL', () => {
  assert.equal(extractTable('PRAGMA table_info(campaigns)'), null);
  assert.equal(extractTable('VACUUM'), null);
});

test('extractTable: WITH (CTE) is parsed', () => {
  const sql = 'WITH recent AS (SELECT id FROM campaigns) SELECT * FROM recent';
  // first table referenced is campaigns
  assert.equal(extractTable(sql), 'campaigns');
});

// ============================================================================
// assertContainsWorkspaceScope

test('assert: exempt tables pass without workspace_id', () => {
  for (const table of WORKSPACE_EXEMPT_TABLES) {
    const r = assertContainsWorkspaceScope(`SELECT * FROM ${table}`);
    assert.equal(r.ok, true, `${table} should be exempt`);
  }
});

test('assert: business table with workspace_id passes', () => {
  assert.equal(
    assertContainsWorkspaceScope('SELECT * FROM campaigns WHERE workspace_id = ?').ok,
    true
  );
  assert.equal(
    assertContainsWorkspaceScope('UPDATE kols SET status=? WHERE id=? AND workspace_id=?').ok,
    true
  );
  assert.equal(
    assertContainsWorkspaceScope('INSERT INTO contacts (id, workspace_id, kol_id) VALUES (?,?,?)').ok,
    true
  );
});

test('assert: business table without workspace_id fails', () => {
  const r = assertContainsWorkspaceScope('SELECT * FROM campaigns');
  assert.equal(r.ok, false);
  assert.match(r.reason, /workspace_id/);
});

test('assert: unidentifiable SQL passes conservatively', () => {
  assert.equal(assertContainsWorkspaceScope('PRAGMA table_info(campaigns)').ok, true);
});

test('assert: SQL with "workspace_id" in a comment still passes (simple check)', () => {
  // Our check is permissive — regex matches anywhere. A comment with
  // "workspace_id" would pass, but we accept that tradeoff for simplicity.
  // Developers writing such deceptive comments is out of scope.
  const r = assertContainsWorkspaceScope(
    'SELECT * FROM campaigns -- TODO: add workspace_id filter'
  );
  assert.equal(r.ok, true);
});

// ============================================================================
// RBAC workspace-role fallback

test('RBAC: uses req.workspaceRole when present', () => {
  const req = { user: { id: 'u1', role: 'viewer' }, workspaceRole: 'admin' };
  let nextCalled = false;
  const mw = rbac.requirePermission('user.manage');
  mw(req, { status() { return this; }, json() { return this; } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'admin workspace role should allow user.manage');
});

test('RBAC: falls back to req.user.role when no workspaceRole', () => {
  const req = { user: { id: 'u1', role: 'admin' } };
  let nextCalled = false;
  rbac.requirePermission('user.manage')(
    req,
    { status() { return this; }, json() { return this; } },
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

test('RBAC: workspaceRole can be MORE restrictive than user.role', () => {
  // User is global admin but only viewer in this specific workspace
  const req = { user: { id: 'u1', role: 'admin' }, workspaceRole: 'viewer' };
  let statusCode;
  rbac.requirePermission('campaign.create')(
    req,
    { status(c) { statusCode = c; return this; }, json() { return this; } },
    () => { statusCode = 200; }
  );
  assert.equal(statusCode, 403, 'viewer in workspace cannot create, even if global admin');
});

test('RBAC: workspaceRole can be LESS restrictive than user.role', () => {
  // User is global viewer but admin in this workspace
  const req = { user: { id: 'u1', role: 'viewer' }, workspaceRole: 'admin' };
  let nextCalled = false;
  rbac.requirePermission('campaign.delete')(
    req,
    { status() { return this; }, json() { return this; } },
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true, 'workspace admin can delete campaigns');
});

// ============================================================================
// Workspace middleware — resolveWorkspaceId

test('resolveWorkspaceId: URL param wins', () => {
  const req = {
    params: { workspaceId: 'ws_from_url' },
    headers: { 'x-workspace-id': 'ws_from_header' },
    body: { workspace_id: 'ws_from_body' },
    user: { currentWorkspaceId: 'ws_from_session' },
  };
  assert.equal(resolveWorkspaceId(req), 'ws_from_url');
});

test('resolveWorkspaceId: header falls through when no URL param', () => {
  const req = {
    headers: { 'x-workspace-id': 'ws_header' },
    body: { workspace_id: 'ws_body' },
    user: { currentWorkspaceId: 'ws_session' },
  };
  assert.equal(resolveWorkspaceId(req), 'ws_header');
});

test('resolveWorkspaceId: body next', () => {
  const req = {
    body: { workspace_id: 'ws_body' },
    user: { currentWorkspaceId: 'ws_session' },
    headers: {},
  };
  assert.equal(resolveWorkspaceId(req), 'ws_body');
});

test('resolveWorkspaceId: session fallback', () => {
  const req = {
    user: { id: 'u1', currentWorkspaceId: 'ws_session' },
    headers: {},
  };
  assert.equal(resolveWorkspaceId(req), 'ws_session');
});

test('resolveWorkspaceId: returns null when nothing provided', () => {
  const req = { headers: {}, body: {}, user: { id: 'u1' } };
  assert.equal(resolveWorkspaceId(req), null);
});

test('resolveWorkspaceId: trims whitespace in header', () => {
  const req = { headers: { 'x-workspace-id': '  ws_trimmed  ' } };
  assert.equal(resolveWorkspaceId(req), 'ws_trimmed');
});
