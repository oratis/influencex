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
    // Variadic, like real ioredis: consume() adds n tickets in one call as
    // score,member,score,member,... A 3-arg-only stub silently dropped every
    // ticket past the first, which would make a batch reservation look free.
    zadd: async (key, ...args) => {
      const arr = ensureSet(key);
      for (let i = 0; i + 1 < args.length; i += 2) arr.push([args[i], args[i + 1]]);
    },
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

// Most limiters here are built without a `name` on purpose — several tests
// exist precisely to pin what unnamed limiters do — and each fresh module
// instance warns once about positional bucket names. Keep that expected noise
// out of the runner output.
console.warn = () => {};

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

// ---------------------------------------------------------------------------
// Bucket isolation.
//
// This module keyed its sorted set on `prefix + rawKey` and ignored `name`
// outright, so every limiter built on the default IP keyFn shared ONE window
// per IP. rate-limit.js swaps to this module whenever REDIS_URL is set, which
// meant the isolation fix in #15 covered only the single-replica path — with
// Redis configured, production still had five discovery calls eating half the
// login budget. Mirrors server/__tests__/rate-limit-isolation.test.js.
// ---------------------------------------------------------------------------

const WINDOW = 60 * 1000;

async function run(limiter, ip) {
  const res = fakeRes();
  let passed = false;
  await limiter({ ip, headers: {} }, res, () => { passed = true; });
  return { passed, status: res.statusCode };
}

test('isolation: two limiters with the default keyFn do not share a window', async () => {
  const { mod } = loadWithStub();
  const a = mod.rateLimit({ max: 3, windowMs: WINDOW, redisUrl: 'redis://stub' });
  const b = mod.rateLimit({ max: 3, windowMs: WINDOW, redisUrl: 'redis://stub' });
  const ip = '198.51.100.10';

  for (let i = 0; i < 3; i++) assert.equal((await run(a, ip)).passed, true);
  assert.equal((await run(a, ip)).passed, false, 'limiter A is exhausted');
  assert.equal((await run(b, ip)).passed, true, 'limiter B must be untouched');
});

test('isolation: the tightest limiter no longer governs the others', async () => {
  // Mirrors the real config: discovery is 5/min, auth is 10/min, same IP.
  const { mod } = loadWithStub();
  const discovery = mod.rateLimit({ name: 'discovery', max: 5, windowMs: WINDOW, redisUrl: 'redis://stub' });
  const auth = mod.rateLimit({ name: 'auth', max: 10, windowMs: WINDOW, redisUrl: 'redis://stub' });
  const ip = '198.51.100.11';

  for (let i = 0; i < 5; i++) await run(discovery, ip);
  assert.equal((await run(discovery, ip)).passed, false, 'discovery budget spent');
  for (let i = 0; i < 10; i++) {
    assert.equal((await run(auth, ip)).passed, true, `auth request ${i + 1} must pass`);
  }
  assert.equal((await run(auth, ip)).passed, false, 'auth has its own full budget, then stops');
});

test('isolation: the bucket key carries the namespace', async () => {
  const { mod, sets } = loadWithStub();
  const limiter = mod.rateLimit({ name: 'export', max: 2, windowMs: WINDOW, redisUrl: 'redis://stub' });
  await run(limiter, '198.51.100.14');
  const keys = [...sets.keys()];
  assert.deepEqual(keys, ['influencex:rl:export|198.51.100.14']);
});

test('isolation: same name = shared window (opt-in, used by batch-send)', async () => {
  const { mod } = loadWithStub();
  const name = 'send-email-workspace';
  const limiter = mod.rateLimit({ name, max: 4, windowMs: WINDOW, redisUrl: 'redis://stub', keyFn: () => 'ws:w1' });
  await run(limiter, 'x');
  await run(limiter, 'x');

  // consume() must land in the SAME sorted set as the middleware it shadows,
  // otherwise a batch reservation is written where nothing ever checks it.
  const r = await mod.consume({ name, key: 'ws:w1', n: 2, max: 4, windowMs: WINDOW, redisUrl: 'redis://stub' });
  assert.equal(r.allowed, true);
  assert.equal((await run(limiter, 'x')).passed, false, 'the 2 consumed tickets count against the middleware');
});

test('isolation: an unnamed consume() cannot silently drain a named limiter', async () => {
  const { mod } = loadWithStub();
  const limiter = mod.rateLimit({ name: 'named-only', max: 2, windowMs: WINDOW, redisUrl: 'redis://stub', keyFn: () => 'k' });
  await mod.consume({ key: 'k', n: 5, max: 100, windowMs: WINDOW, redisUrl: 'redis://stub' }); // no name
  assert.equal((await run(limiter, 'x')).passed, true, 'named limiter is unaffected by the anonymous bucket');
});

test('isolation: consume() reserves every ticket, not just the first', async () => {
  // Guards the variadic zadd contract: n tickets must all land in the window,
  // or a batch of 50 would cost one ticket and sail past the cap.
  const { mod } = loadWithStub();
  const opts = { name: 'batch', key: 'ws:w2', max: 5, windowMs: WINDOW, redisUrl: 'redis://stub' };
  assert.equal((await mod.consume({ ...opts, n: 3 })).allowed, true);
  assert.equal((await mod.consume({ ...opts, n: 3 })).allowed, false, 'only 2 tickets left');
  assert.equal((await mod.consume({ ...opts, n: 2 })).allowed, true);
});
