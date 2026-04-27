/**
 * BullMQ-backed job queue. API-compatible with `./job-queue.js`'s in-process
 * queue so the caller in server/index.js can swap based on REDIS_URL.
 *
 *   register(type, handler)         — bind a worker for that job type
 *   push(type, payload, opts?)      — enqueue
 *   pause() / resume()              — toggle worker
 *   drain(timeoutMs?)               — wait until empty (best-effort)
 *   shutdown()                      — close workers + queue connection
 *   on(evt, fn) / off(evt, fn)      — event emitter (job:done, job:error)
 *   getStats()                      — snapshot of counts
 *
 * Multi-instance Cloud Run can now safely run >1 replica because BullMQ uses
 * Redis-backed atomic locks for job pickup.
 *
 * Sprint Q2 tasks A3 + A4.
 */

const { EventEmitter } = require('events');

function createBullQueue({
  redisUrl = process.env.REDIS_URL,
  queueName = process.env.BULLMQ_QUEUE_NAME || 'influencex',
  concurrency = parseInt(process.env.BULLMQ_CONCURRENCY) || 5,
  defaultMaxRetries = 3,
  baseBackoffMs = 1000,
} = {}) {
  if (!redisUrl) {
    throw new Error('createBullQueue requires REDIS_URL (or pass redisUrl)');
  }

  // Lazy-require so units that just import job-queue without env config
  // don't load bullmq at all.
  const { Queue, Worker, QueueEvents } = require('bullmq');
  const IORedis = require('ioredis');

  const connection = new IORedis(redisUrl, {
    // BullMQ needs maxRetriesPerRequest=null so blocking commands work.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  const emitter = new EventEmitter();
  const handlers = new Map(); // jobType -> handler
  const stats = { processed: 0, succeeded: 0, failed: 0, retried: 0 };

  let worker = null;
  let paused = false;
  let shuttingDown = false;

  function ensureWorker() {
    if (worker) return;
    worker = new Worker(queueName, async (job) => {
      const handler = handlers.get(job.name);
      if (!handler) {
        throw new Error(`No handler registered for job type: ${job.name}`);
      }
      // BullMQ injects job.attemptsMade for retry semantics.
      const result = await handler({ id: job.id, type: job.name, payload: job.data, attempt: job.attemptsMade + 1 });
      return result;
    }, { connection, concurrency });

    worker.on('completed', (job) => {
      stats.processed++;
      stats.succeeded++;
      emitter.emit('job:done', { id: job.id, type: job.name });
    });
    worker.on('failed', (job, err) => {
      if (!job) return;
      if (job.attemptsMade < (job.opts.attempts || 1)) {
        stats.retried++;
        return;
      }
      stats.processed++;
      stats.failed++;
      emitter.emit('job:error', { id: job.id, type: job.name, error: err.message });
    });
  }

  function register(jobType, handler) {
    if (typeof handler !== 'function') throw new Error('handler must be a function');
    handlers.set(jobType, handler);
    ensureWorker();
  }

  async function push(jobType, payload, opts = {}) {
    if (!handlers.has(jobType)) {
      // Allow pushing without a registered handler so producer/worker
      // separation still works (handler may register later or in another
      // process).
    }
    const attempts = (opts.maxRetries ?? defaultMaxRetries) + 1;
    const job = await queue.add(jobType, payload || {}, {
      attempts,
      backoff: { type: 'exponential', delay: baseBackoffMs },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 * 7 },
    });
    return { id: job.id };
  }

  async function pause() {
    paused = true;
    if (worker) await worker.pause();
  }

  async function resume() {
    paused = false;
    if (worker) await worker.resume();
  }

  async function drain(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      const remaining = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
      if (remaining === 0) return { remaining: 0 };
      await new Promise(r => setTimeout(r, 100));
    }
    const finalCounts = await queue.getJobCounts('waiting', 'active', 'delayed');
    return { remaining: (finalCounts.waiting || 0) + (finalCounts.active || 0) + (finalCounts.delayed || 0) };
  }

  async function shutdown() {
    shuttingDown = true;
    try { if (worker) await worker.close(); } catch {}
    try { await queue.close(); } catch {}
    try { await queueEvents.close(); } catch {}
    try { await connection.quit(); } catch {}
  }

  async function getStats() {
    let counts = {};
    try { counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'); } catch {}
    return {
      backend: 'bullmq',
      queueName,
      ...stats,
      registeredTypes: Array.from(handlers.keys()),
      concurrency,
      paused,
      counts,
    };
  }

  return {
    register, push, pause, resume, drain, shutdown,
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    getStats,
  };
}

module.exports = { createBullQueue };
