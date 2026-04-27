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

test('createBullQueue: builds object with expected API surface (stubbed bullmq+ioredis)', () => {
  const stubConn = { quit: () => Promise.resolve() };
  const stubQueue = {
    add: () => Promise.resolve({ id: 'job-1' }),
    close: () => Promise.resolve(),
    getJobCounts: () => Promise.resolve({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 }),
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
  const { createBullQueue } = require('../bullmq-queue');
  const q = createBullQueue({ redisUrl: 'redis://stub:6379', queueName: 'test-only' });
  for (const fn of ['register', 'push', 'pause', 'resume', 'drain', 'shutdown', 'on', 'off', 'getStats']) {
    assert.equal(typeof q[fn], 'function', `${fn} should be a function`);
  }
});
