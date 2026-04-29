const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub ioredis with an in-memory sorted-set mock. Just enough behavior to
// validate the rate limiter logic.
function loadWithStub({ failExec = false } = {}) {
  // key -> Array<[score, member]>
  const sets = new Map();
  const ensureSet = (key) => { if (!sets.has(key)) sets.set(key, []); return sets.get(key); };

  const stubClient = {
    on: () => {},
    multi() {
      const ops = [];
      const m = {
        zremrangebyscore: (key, min, max) => { ops.push(['zremrangebyscore', key, min, max]); return m; },
        zcard: (key) => { ops.push(['zcard', key]); return m; },
        exec: async () => {
          if (failExec) throw new Error('boom');
          const out = [];
          for (const op of ops) {
            if (op[0] === 'zremrangebyscore') {
              const arr = ensureSet(op[1]);
              const filtered = arr.filter(([score]) => score < op[2] || score > op[3]);
              const removed = arr.length - filtered.length;
              sets.set(op[1], filtered);
              out.push([null, removed]);
            } else if (op[0] === 'zcard') {
              out.push([null, ensureSet(op[1]).length]);
            }
          }
          return out;
        },
      };
      return m;
    },
    zadd: async (key, score, member) => { ensureSet(key).push([score, member]); },
    zrange: async (key, start, stop, withscores) => {
      const arr = [...ensureSet(key)].sort((a, b) => a[0] - b[0]);
      const slice = arr.slice(start, stop + 1);
      if (withscores === 'WITHSCORES') return slice.flatMap(([score, member]) => [member, String(score)]);
      return slice.map(([, member]) => member);
    },
    pexpire: async () => 1,
    info: async () => 'ok',
  };
  require.cache[require.resolve('ioredis')] = {
    exports: function () { return stubClient; },
    loaded: true,
    id: require.resolve('ioredis'),
    filename: require.resolve('ioredis'),
    children: [],
    parent: null,
  };
  delete require.cache[require.resolve('../redis-rate-limit')];
  return { mod: require('../redis-rate-limit'), sets };
}

function fakeRes() {
  const r = {
    headers: {},
    statusCode: 200,
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return r;
}

beforeEach(() => {
  delete require.cache[require.resolve('ioredis')];
});

test('rateLimit: throws without REDIS_URL', () => {
  delete process.env.REDIS_URL;
  delete require.cache[require.resolve('../redis-rate-limit')];
  const { rateLimit } = require('../redis-rate-limit');
  assert.throws(() => rateLimit({ max: 5, windowMs: 1000 }), /REDIS_URL/i);
});

test('rateLimit: lets requests through under cap', async () => {
  const { mod } = loadWithStub();
  const limiter = mod.rateLimit({ max: 3, windowMs: 1000, redisUrl: 'redis://stub', keyFn: () => 'user-a' });
  let nextCalls = 0;
  const next = () => { nextCalls++; };
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    await limiter({ ip: 'x' }, res, next);
  }
  assert.equal(nextCalls, 3);
});

test('rateLimit: blocks request when over cap', async () => {
  const { mod } = loadWithStub();
  const limiter = mod.rateLimit({ max: 2, windowMs: 1000, redisUrl: 'redis://stub', keyFn: () => 'user-b' });
  const next = () => {};
  await limiter({ ip: 'x' }, fakeRes(), next);
  await limiter({ ip: 'x' }, fakeRes(), next);
  const blocked = fakeRes();
  await limiter({ ip: 'x' }, blocked, next);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, 'RATE_LIMITED');
  assert.ok(blocked.headers['Retry-After']);
});

test('rateLimit: separate keys have independent buckets', async () => {
  const { mod } = loadWithStub();
  let i = 0;
  const limiter = mod.rateLimit({ max: 1, windowMs: 1000, redisUrl: 'redis://stub', keyFn: () => `user-${i++}` });
  let nextCalls = 0;
  const next = () => { nextCalls++; };
  await limiter({ ip: 'x' }, fakeRes(), next);
  await limiter({ ip: 'x' }, fakeRes(), next);
  await limiter({ ip: 'x' }, fakeRes(), next);
  // Each call uses a different key, so all 3 pass under their own cap of 1.
  assert.equal(nextCalls, 3);
});

test('rateLimit: fails open on Redis error (calls next, does not 429)', async () => {
  const { mod } = loadWithStub({ failExec: true });
  const limiter = mod.rateLimit({ max: 1, windowMs: 1000, redisUrl: 'redis://stub', keyFn: () => 'user-c' });
  let nextCalled = false;
  const res = fakeRes();
  await limiter({ ip: 'x' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200); // never wrote 429
});
