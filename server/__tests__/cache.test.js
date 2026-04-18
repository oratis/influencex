const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../cache');

test('set/get round trip', () => {
  const c = createCache();
  c.set('foo', 'bar');
  assert.equal(c.get('foo'), 'bar');
});

test('get returns undefined for missing key', () => {
  const c = createCache();
  assert.equal(c.get('nope'), undefined);
});

test('expired entries are evicted on read', async () => {
  const c = createCache();
  c.set('short', 'x', 20);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(c.get('short'), undefined);
  const s = c.getStats();
  assert.equal(s.expired, 1);
});

test('ttl of null means no expiry', () => {
  const c = createCache({ defaultTtlMs: 10 });
  c.set('forever', 'yes', null);
  // Even after the default TTL would have expired
  assert.equal(c.get('forever'), 'yes');
});

test('delete removes key', () => {
  const c = createCache();
  c.set('k', 'v');
  assert.equal(c.delete('k'), true);
  assert.equal(c.get('k'), undefined);
});

test('clear empties all entries', () => {
  const c = createCache();
  c.set('a', 1);
  c.set('b', 2);
  c.clear();
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.getStats().size, 0);
});

test('hit/miss stats are tracked', () => {
  const c = createCache();
  c.set('k', 'v');
  c.get('k');           // hit
  c.get('k');           // hit
  c.get('missing');     // miss
  const s = c.getStats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 0.001);
});

test('maxKeys triggers LRU eviction of oldest', () => {
  const c = createCache({ maxKeys: 3 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4);         // should evict 'a'
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('d'), 4);
  assert.equal(c.getStats().evictions, 1);
});

test('accessing key promotes it (LRU behavior)', () => {
  const c = createCache({ maxKeys: 3 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.get('a');            // touch 'a' — now 'b' is oldest
  c.set('d', 4);         // should evict 'b'
  assert.equal(c.get('a'), 1, "'a' should still be present");
  assert.equal(c.get('b'), undefined, "'b' should have been evicted");
});

test('remember: computes on miss, caches on subsequent', async () => {
  const c = createCache();
  let callCount = 0;
  const producer = async () => { callCount += 1; return 'computed'; };
  const v1 = await c.remember('k', producer);
  const v2 = await c.remember('k', producer);
  assert.equal(v1, 'computed');
  assert.equal(v2, 'computed');
  assert.equal(callCount, 1, 'producer should only run once');
});

test('remember: honors explicit ttl', async () => {
  const c = createCache();
  let callCount = 0;
  const producer = async () => { callCount += 1; return callCount; };
  await c.remember('k', producer, 20);
  await new Promise(r => setTimeout(r, 50));
  const v2 = await c.remember('k', producer, 20);
  assert.equal(callCount, 2);
  assert.equal(v2, 2);
});
