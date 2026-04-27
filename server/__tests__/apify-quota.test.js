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
