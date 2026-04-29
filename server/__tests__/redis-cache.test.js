const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub ioredis BEFORE requiring redis-cache. We intercept the constructor
// call and return an in-memory mock so no real connection is opened.
function loadWithStub({ failOnGet = false, failOnSet = false } = {}) {
  const fakeStore = new Map();
  const stubClient = {
    on: () => {},
    get: async (k) => { if (failOnGet) throw new Error('boom'); return fakeStore.get(k) ?? null; },
    set: async (k, v, ...rest) => { if (failOnSet) throw new Error('boom'); fakeStore.set(k, v); return 'OK'; },
    del: async (...keys) => { for (const k of keys) fakeStore.delete(k); },
    scanStream: () => {
      // async iterable that yields one batch of all keys
      const keys = Array.from(fakeStore.keys());
      return {
        [Symbol.asyncIterator]: async function* () { if (keys.length) yield keys; },
      };
    },
    quit: async () => {},
  };
  require.cache[require.resolve('ioredis')] = {
    exports: function () { return stubClient; },
    loaded: true,
    id: require.resolve('ioredis'),
    filename: require.resolve('ioredis'),
    children: [],
    parent: null,
  };
  delete require.cache[require.resolve('../redis-cache')];
  const { createRedisCache } = require('../redis-cache');
  return { createRedisCache, fakeStore };
}

beforeEach(() => {
  // Clean any prior stubs
  delete require.cache[require.resolve('ioredis')];
});

test('createRedisCache: throws without REDIS_URL', () => {
  delete process.env.REDIS_URL;
  delete require.cache[require.resolve('../redis-cache')];
  const { createRedisCache } = require('../redis-cache');
  assert.throws(() => createRedisCache({}), /REDIS_URL/i);
});

test('get: returns undefined on miss, value on hit (round-trip JSON)', async () => {
  const { createRedisCache } = loadWithStub();
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  assert.equal(await c.get('foo'), undefined);
  await c.set('foo', { x: 1 });
  assert.deepEqual(await c.get('foo'), { x: 1 });
});

test('get: fails open on Redis error (returns undefined, no throw)', async () => {
  const { createRedisCache } = loadWithStub({ failOnGet: true });
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  assert.equal(await c.get('any'), undefined); // must not throw
  const stats = c.getStats();
  assert.ok(stats.errors >= 1);
});

test('set: fails open on Redis error (no throw)', async () => {
  const { createRedisCache } = loadWithStub({ failOnSet: true });
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  await c.set('x', 'y'); // must not throw
});

test('remember: caches the function result, second call hits cache', async () => {
  const { createRedisCache } = loadWithStub();
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  let calls = 0;
  const fn = async () => { calls++; return { n: calls }; };
  const v1 = await c.remember('k', fn);
  const v2 = await c.remember('k', fn);
  assert.deepEqual(v1, v2);
  assert.equal(calls, 1);
});

test('clear: removes all prefixed keys', async () => {
  const { createRedisCache, fakeStore } = loadWithStub();
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  await c.set('a', 1);
  await c.set('b', 2);
  assert.equal(fakeStore.size, 2);
  await c.clear();
  assert.equal(fakeStore.size, 0);
});

test('getStats: includes hits / misses / sets / errors', async () => {
  const { createRedisCache } = loadWithStub();
  const c = createRedisCache({ redisUrl: 'redis://stub' });
  await c.set('x', 1);
  await c.get('x');
  await c.get('missing');
  const s = c.getStats();
  assert.equal(s.sets, 1);
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.backend, 'redis');
});
