const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('../job-queue');

function waitForStats(queue, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate(queue.getStats())) return resolve(queue.getStats());
      if (Date.now() - start > timeoutMs) return reject(new Error('waitForStats timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('push and run a simple job', async () => {
  const q = createQueue({ concurrency: 1 });
  let ran = false;
  q.register('simple', async () => { ran = true; });
  q.push('simple', {});
  await waitForStats(q, s => s.completed === 1);
  assert.equal(ran, true);
  assert.equal(q.getStats().completed, 1);
});

test('throws when pushing unknown job type', () => {
  const q = createQueue();
  assert.throws(() => q.push('unregistered', {}), /No handler/);
});

test('concurrency limit is respected', async () => {
  const q = createQueue({ concurrency: 2 });
  let running = 0;
  let maxSeen = 0;
  q.register('slow', async () => {
    running += 1;
    maxSeen = Math.max(maxSeen, running);
    await new Promise(r => setTimeout(r, 30));
    running -= 1;
  });
  for (let i = 0; i < 5; i++) q.push('slow', { i });
  await waitForStats(q, s => s.completed === 5);
  assert.ok(maxSeen <= 2, `max concurrent was ${maxSeen}, expected <= 2`);
});

test('retries on failure with backoff', async () => {
  const q = createQueue({ concurrency: 1, baseBackoffMs: 10 });
  let attempts = 0;
  q.register('flaky', async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('transient');
  });
  q.push('flaky', {}, { maxRetries: 5 });
  await waitForStats(q, s => s.completed === 1, 3000);
  assert.equal(attempts, 3);
  assert.equal(q.getStats().retried, 2);
});

test('gives up after maxRetries', async () => {
  const q = createQueue({ concurrency: 1, baseBackoffMs: 5 });
  q.register('doomed', async () => { throw new Error('nope'); });
  q.push('doomed', {}, { maxRetries: 2 });
  await waitForStats(q, s => s.failed === 1, 3000);
  assert.equal(q.getStats().completed, 0);
  assert.equal(q.getStats().failed, 1);
});

test('emits lifecycle events', async () => {
  const q = createQueue({ concurrency: 1 });
  const events = [];
  q.on('enqueued', () => events.push('enqueued'));
  q.on('running', () => events.push('running'));
  q.on('completed', () => events.push('completed'));
  q.register('test', async () => {});
  q.push('test', {});
  await waitForStats(q, s => s.completed === 1);
  assert.deepEqual(events, ['enqueued', 'running', 'completed']);
});

test('pause/resume halts processing', async () => {
  const q = createQueue({ concurrency: 1 });
  q.register('noop', async () => {});
  q.pause();
  q.push('noop', {});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(q.getStats().completed, 0, 'should not process while paused');
  q.resume();
  await waitForStats(q, s => s.completed === 1);
});

test('drain waits for all jobs', async () => {
  const q = createQueue({ concurrency: 2 });
  q.register('quick', async () => { await new Promise(r => setTimeout(r, 20)); });
  for (let i = 0; i < 3; i++) q.push('quick', {});
  const result = await q.drain();
  assert.equal(result.remaining, 0);
  assert.equal(q.getStats().completed, 3);
});

test('delayMs postpones execution', async () => {
  const q = createQueue({ concurrency: 1 });
  let runAt = null;
  const pushedAt = Date.now();
  q.register('delayed', async () => { runAt = Date.now(); });
  q.push('delayed', {}, { delayMs: 100 });
  await waitForStats(q, s => s.completed === 1, 2000);
  assert.ok(runAt - pushedAt >= 90, `ran only ${runAt - pushedAt}ms after push`);
});

test('getStats reports registered types', () => {
  const q = createQueue();
  q.register('a', async () => {});
  q.register('b', async () => {});
  const s = q.getStats();
  assert.deepEqual(s.registeredTypes.sort(), ['a', 'b']);
});
