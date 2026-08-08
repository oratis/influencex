const { test } = require('node:test');
const assert = require('node:assert/strict');

// We never let this test actually connect to Redis. Each test resets the
// require cache so REDIS_URL state and the bullmq/ioredis stubs apply fresh.

test('createBullQueue: throws when REDIS_URL unset', () => {
  delete process.env.REDIS_URL;
  delete require.cache[require.resolve('../bullmq-queue')];
  const { createBullQueue } = require('../bullmq-queue');
  assert.throws(() => createBullQueue({}), /REDIS_URL/i);
});

test('createBullQueue: factory exists', () => {
  delete require.cache[require.resolve('../bullmq-queue')];
  const mod = require('../bullmq-queue');
  assert.equal(typeof mod.createBullQueue, 'function');
});

// Install bullmq/ioredis stubs into the require cache and return a freshly
// loaded factory. `counts` feeds the stub queue's getJobCounts.
function loadWithStubs({ counts = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 } } = {}) {
  const stubConn = { quit: () => Promise.resolve() };
  const stubQueue = {
    add: () => Promise.resolve({ id: 'job-1' }),
    close: () => Promise.resolve(),
    getJobCounts: () => Promise.resolve({ ...counts }),
  };
  const stubWorker = {
    on: () => stubWorker,
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  const stubEvents = { close: () => Promise.resolve() };

  require.cache[require.resolve('bullmq')] = {
    exports: {
      Queue: function () { return stubQueue; },
      Worker: function () { return stubWorker; },
      QueueEvents: function () { return stubEvents; },
    },
    loaded: true,
    id: require.resolve('bullmq'),
    filename: require.resolve('bullmq'),
    children: [],
    parent: null,
  };
  require.cache[require.resolve('ioredis')] = {
    exports: function () { return stubConn; },
    loaded: true,
    id: require.resolve('ioredis'),
    filename: require.resolve('ioredis'),
    children: [],
    parent: null,
  };
  delete require.cache[require.resolve('../bullmq-queue')];
  return require('../bullmq-queue');
}

test('createBullQueue: builds object with expected API surface (stubbed bullmq+ioredis)', () => {
  const { createBullQueue } = loadWithStubs();
  const q = createBullQueue({ redisUrl: 'redis://stub:6379', queueName: 'test-only' });
  for (const fn of ['register', 'push', 'pause', 'resume', 'drain', 'shutdown', 'on', 'off', 'getStats']) {
    assert.equal(typeof q[fn], 'function', `${fn} should be a function`);
  }
});

test('getStats() normalizes to the in-process queue stats shape', async () => {
  const { createBullQueue } = loadWithStubs({
    counts: { waiting: 2, active: 1, delayed: 1, completed: 7, failed: 1 },
  });
  const q = createBullQueue({ redisUrl: 'redis://stub:6379', queueName: 'shape-test' });
  q.register('email.send', async () => {});
  const s = await q.getStats();

  assert.equal(s.backend, 'bullmq');
  assert.equal(s.pending, 3, 'pending = waiting + delayed');
  assert.equal(s.running, 1, 'running = active');
  assert.deepEqual(s.registeredTypes, ['email.send']);

  // Every key the in-process queue exposes must be present, so
  // /api/queue/stats, /api/email-queue/stats and the /metrics gauges can
  // read either backend without branching.
  const { createQueue } = require('../job-queue');
  const inproc = createQueue();
  inproc.register('email.send', async () => {});
  for (const key of Object.keys(inproc.getStats())) {
    assert.ok(key in s, `bullmq getStats missing in-process key "${key}"`);
  }
});

test('push() resolves to a raw job id — same shape as in-process push', async () => {
  const { createBullQueue } = loadWithStubs();
  const q = createBullQueue({ redisUrl: 'redis://stub:6379', queueName: 'push-test' });
  const id = await q.push('email.send', { contactId: 'c1' });
  assert.equal(id, 'job-1');
});
