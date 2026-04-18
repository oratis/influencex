/**
 * In-process job queue with retry, exponential backoff, and concurrency control.
 *
 * For small/medium deployments this avoids the operational cost of Redis + BullMQ.
 * For multi-replica setups, swap this out for BullMQ — same public API shape.
 *
 * Usage:
 *   const queue = createQueue({ concurrency: 3 });
 *   queue.register('scrape-kol', async (job) => { ... });
 *   queue.push('scrape-kol', { url: '...' }, { maxRetries: 3 });
 */

const { EventEmitter } = require('events');

function createQueue({ concurrency = 2, defaultMaxRetries = 3, baseBackoffMs = 1000 } = {}) {
  const handlers = new Map();     // jobType -> handler fn
  const pending = [];             // waiting jobs
  const running = new Set();      // in-flight jobs
  const emitter = new EventEmitter();
  const stats = {
    total: 0,
    completed: 0,
    failed: 0,
    retried: 0,
  };
  let nextId = 1;
  let paused = false;
  let shuttingDown = false;

  function register(jobType, handler) {
    if (typeof handler !== 'function') throw new Error('handler must be a function');
    handlers.set(jobType, handler);
  }

  function push(jobType, payload, opts = {}) {
    if (!handlers.has(jobType)) {
      throw new Error(`No handler registered for job type: ${jobType}`);
    }
    const job = {
      id: nextId++,
      type: jobType,
      payload,
      attempts: 0,
      maxRetries: opts.maxRetries ?? defaultMaxRetries,
      createdAt: Date.now(),
      runAt: opts.delayMs ? Date.now() + opts.delayMs : Date.now(),
      state: 'pending',
      lastError: null,
    };
    pending.push(job);
    stats.total += 1;
    emitter.emit('enqueued', job);
    scheduleNext();
    return job.id;
  }

  function pickNextReady() {
    const now = Date.now();
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].runAt <= now) {
        return pending.splice(i, 1)[0];
      }
    }
    return null;
  }

  async function run(job) {
    running.add(job);
    job.state = 'running';
    job.attempts += 1;
    emitter.emit('running', job);

    const handler = handlers.get(job.type);
    try {
      const result = await handler(job);
      job.state = 'completed';
      stats.completed += 1;
      emitter.emit('completed', job, result);
    } catch (e) {
      job.lastError = e.message || String(e);
      if (job.attempts >= job.maxRetries) {
        job.state = 'failed';
        stats.failed += 1;
        emitter.emit('failed', job, e);
      } else {
        // Retry with exponential backoff + small jitter
        const backoff = baseBackoffMs * Math.pow(2, job.attempts - 1);
        const jitter = Math.floor(Math.random() * 250);
        job.runAt = Date.now() + backoff + jitter;
        job.state = 'retrying';
        stats.retried += 1;
        pending.push(job);
        emitter.emit('retrying', job, e);
      }
    } finally {
      running.delete(job);
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (paused || shuttingDown) return;
    while (running.size < concurrency) {
      const job = pickNextReady();
      if (!job) break;
      run(job); // fire-and-forget, manages state internally
    }

    // If there are delayed jobs but none ready right now, schedule a tick
    if (running.size < concurrency && pending.length > 0) {
      const nextRunAt = Math.min(...pending.map(j => j.runAt));
      const delay = Math.max(10, nextRunAt - Date.now());
      if (delay < 60_000) {
        setTimeout(scheduleNext, delay).unref?.();
      }
    }
  }

  function pause() { paused = true; }
  function resume() { paused = false; scheduleNext(); }

  async function drain(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while ((running.size > 0 || pending.length > 0) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    return { remaining: running.size + pending.length };
  }

  function shutdown() {
    shuttingDown = true;
    return drain(5000);
  }

  function getStats() {
    return {
      ...stats,
      pending: pending.length,
      running: running.size,
      registeredTypes: Array.from(handlers.keys()),
      concurrency,
      paused,
    };
  }

  return {
    register, push, pause, resume, drain, shutdown,
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    getStats,
  };
}

module.exports = { createQueue };
