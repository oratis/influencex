const { test } = require('node:test');
const assert = require('node:assert/strict');

// Reload the module fresh for each test to get clean state.
// Node's test runner doesn't have jest.resetModules, so we delete from cache.
function freshQuota() {
  delete require.cache[require.resolve('../youtube-quota')];
  return require('../youtube-quota');
}

test('canCall: allowed under quota', () => {
  const q = freshQuota();
  const result = q.canCall('search', 1);
  assert.equal(result.allowed, true);
  assert.equal(result.cost, 100);
});

test('canCall: blocked when quota exhausted', () => {
  const q = freshQuota();
  // Burn through nearly all the quota
  for (let i = 0; i < 90; i++) q.record('search', 1);
  const result = q.canCall('search', 1);
  assert.equal(result.allowed, false);
});

test('record: accumulates usage', () => {
  const q = freshQuota();
  q.record('search', 1);
  q.record('channels', 1);
  q.record('channels', 1);
  const s = q.status();
  assert.equal(s.used, 100 + 1 + 1);
  assert.equal(s.byEndpoint.search, 100);
  assert.equal(s.byEndpoint.channels, 2);
});

test('status: returns current state with correct fields', () => {
  const q = freshQuota();
  const s = q.status();
  assert.ok(typeof s.date === 'string');
  assert.equal(s.used, 0);
  assert.ok(s.dailyLimit > 0);
  assert.equal(s.remaining, s.dailyLimit);
  assert.equal(s.utilization, 0);
  assert.deepEqual(s.byEndpoint, {});
});

test('COSTS: search is 100, channels/videos/playlistItems are 1', () => {
  const q = freshQuota();
  assert.equal(q.COSTS.search, 100);
  assert.equal(q.COSTS.channels, 1);
  assert.equal(q.COSTS.videos, 1);
  assert.equal(q.COSTS.playlistItems, 1);
});

test('canCall: unknown endpoint defaults to cost 1', () => {
  const q = freshQuota();
  const result = q.canCall('unknown-endpoint', 1);
  assert.equal(result.cost, 1);
  assert.equal(result.allowed, true);
});

test('utilization grows with usage', () => {
  const q = freshQuota();
  q.record('search', 1);
  const s = q.status();
  assert.ok(s.utilization > 0);
  assert.ok(s.utilization < 1);
});
