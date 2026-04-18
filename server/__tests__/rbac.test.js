const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission, requirePermission, getRolePermissions, ROLES } = require('../rbac');

test('admin has all permissions', () => {
  assert.ok(hasPermission('admin', 'user.manage'));
  assert.ok(hasPermission('admin', 'campaign.delete'));
  assert.ok(hasPermission('admin', 'email.send'));
  assert.ok(hasPermission('admin', 'data.export'));
  assert.ok(hasPermission('admin', 'system.manage'));
});

test('editor can create and send, cannot delete campaigns or manage users', () => {
  assert.ok(hasPermission('editor', 'campaign.create'));
  assert.ok(hasPermission('editor', 'email.send'));
  assert.ok(hasPermission('editor', 'data.export'));
  assert.equal(hasPermission('editor', 'campaign.delete'), false);
  assert.equal(hasPermission('editor', 'user.manage'), false);
  assert.equal(hasPermission('editor', 'system.manage'), false);
});

test('viewer only has read permissions', () => {
  assert.ok(hasPermission('viewer', 'campaign.read'));
  assert.ok(hasPermission('viewer', 'kol.read'));
  assert.equal(hasPermission('viewer', 'email.send'), false);
  assert.equal(hasPermission('viewer', 'campaign.create'), false);
  assert.equal(hasPermission('viewer', 'kol.delete'), false);
});

test('member is an alias for editor', () => {
  const memberPerms = getRolePermissions('member');
  const editorPerms = getRolePermissions('editor');
  assert.deepEqual(memberPerms.sort(), editorPerms.sort());
});

test('unknown role falls back to viewer (safe default)', () => {
  assert.equal(hasPermission('hacker', 'email.send'), false);
  assert.ok(hasPermission('hacker', 'campaign.read'));
});

test('getRolePermissions returns an array', () => {
  const perms = getRolePermissions('admin');
  assert.ok(Array.isArray(perms));
  assert.ok(perms.length > 0);
});

test('ROLES list is exported', () => {
  assert.deepEqual(ROLES, ['admin', 'editor', 'viewer']);
});

test('requirePermission: returns 401 when no user', () => {
  const mw = requirePermission('email.send');
  let statusCode, jsonBody;
  const req = {};
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(nextCalled, false);
  assert.ok(jsonBody.error);
});

test('requirePermission: returns 403 when user lacks permission', () => {
  const mw = requirePermission('campaign.delete');
  let statusCode, jsonBody;
  const req = { user: { role: 'viewer' } };
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
  assert.match(jsonBody.error, /campaign\.delete/);
});

test('requirePermission: calls next() when user has permission', () => {
  const mw = requirePermission('campaign.read');
  const req = { user: { role: 'viewer' } };
  const res = {
    status() { assert.fail('should not be called'); },
    json() { assert.fail('should not be called'); },
  };
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
