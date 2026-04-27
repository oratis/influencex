const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshQuota() {
  delete require.cache[require.resolve('../apify-quota')];
  return require('../apify-quota');
}

test('canCall: allowed under fresh quota', () => {
  const q = freshQuota();
  const r = q.canCall('apify/instagram-hashtag-scraper', 50);
  assert.equal(r.allowed, true);
  assert.equal(r.runs, 0);
  assert.equal(r.items, 0);
});

test('canCall: blocked when run quota exhausted', () => {
  const q = freshQuota();
  // Default APIFY_DAILY_RUN_QUOTA = 200, with 0.9 safety = 180 effective.
  for (let i = 0; i < 180; i++) q.record('apify/instagram-hashtag-scraper', 0);
  const r = q.canCall('apify/instagram-hashtag-scraper', 10);
  assert.equal(r.allowed, false);
  assert.equal(r.runRemaining, 0);
});

test('canCall: blocked when items quota would be exceeded', () => {
  const q = freshQuota();
  // Effective items limit = 10000 * 0.9 = 9000.
  q.record('apify/x', 8990);
  const r = q.canCall('apify/x', 50);
  assert.equal(r.allowed, false);
  assert.ok(r.itemsRemaining < 50);
});

test('record: accumulates runs and items per actor', () => {
  const q = freshQuota();
  q.record('apify/ig', 30);
  q.record('apify/ig', 20);
  q.record('clockworks/tt', 40);
  const s = q.status();
  assert.equal(s.runs, 3);
  assert.equal(s.items, 90);
  assert.equal(s.byActor['apify/ig'].runs, 2);
  assert.equal(s.byActor['apify/ig'].items, 50);
  assert.equal(s.byActor['clockworks/tt'].runs, 1);
});

test('status: includes utilization fields', () => {
  const q = freshQuota();
  q.record('apify/x', 100);
  const s = q.status();
  assert.ok(s.runUtilization > 0);
  assert.ok(s.itemsUtilization > 0);
  assert.ok(typeof s.date === 'string');
});

test('_resetForTest: clears state', () => {
  const q = freshQuota();
  q.record('apify/x', 100);
  q._resetForTest();
  const s = q.status();
  assert.equal(s.runs, 0);
  assert.equal(s.items, 0);
  assert.deepEqual(s.byActor, {});
});

test('canCall: per-workspace quota is independent of global', () => {
  const q = freshQuota();
  // Default APIFY_WORKSPACE_DAILY_RUN_QUOTA = 50, with 0.9 safety = 45 effective.
  for (let i = 0; i < 45; i++) q.record('apify/x', 0, 'ws-A');
  // Workspace A is exhausted, B is fresh.
  const a = q.canCall('apify/x', 1, 'ws-A');
  const b = q.canCall('apify/x', 1, 'ws-B');
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'workspace_quota_exceeded');
  assert.equal(b.allowed, true);
});

test('record: per-workspace counts attribute correctly', () => {
  const q = freshQuota();
  q.record('apify/x', 10, 'ws-A');
  q.record('apify/x', 20, 'ws-A');
  q.record('apify/x', 5, 'ws-B');
  const s = q.status();
  assert.equal(s.byWorkspace['ws-A'].runs, 2);
  assert.equal(s.byWorkspace['ws-A'].items, 30);
  assert.equal(s.byWorkspace['ws-B'].runs, 1);
  assert.equal(s.byWorkspace['ws-B'].items, 5);
});

test('canCall: omitting workspaceId only checks global', () => {
  const q = freshQuota();
  // Heavy workspace usage but no workspaceId in canCall — should still be allowed.
  for (let i = 0; i < 45; i++) q.record('apify/x', 0, 'ws-noisy');
  const r = q.canCall('apify/x', 1);
  assert.equal(r.allowed, true);
  assert.equal(r.workspace, null);
});

test('status: per-workspace returns workspace block', () => {
  const q = freshQuota();
  q.record('apify/x', 10, 'ws-A');
  const s = q.status('ws-A');
  assert.ok(s.workspace);
  assert.equal(s.workspace.runs, 1);
  assert.equal(s.workspace.items, 10);
  assert.ok(s.workspace.runUtilization > 0);
});
