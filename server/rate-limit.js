/**
 * Simple in-memory rate limiter.
 *
 * Not suitable for multi-replica deployments — for that, back this with Redis.
 * For single-instance Cloud Run it is adequate.
 *
 * Uses a sliding window: for each key, we record timestamps of recent requests
 * and compare to the limit within the window. Entries are pruned on each call.
 */

const buckets = new Map(); // key -> number[] of timestamp ms

function prune(key, windowMs) {
  const now = Date.now();
  const list = buckets.get(key);
  if (!list) return;
  const cutoff = now - windowMs;
  while (list.length && list[0] < cutoff) list.shift();
  if (list.length === 0) buckets.delete(key);
}

/**
 * Express middleware factory.
 *
 * @param {Object} opts
 * @param {number} opts.max    - Max requests allowed in the window.
 * @param {number} opts.windowMs - Window size in milliseconds.
 * @param {Function} [opts.keyFn] - Extract key from request (default: IP).
 * @param {string} [opts.message] - Error message when rate-limited.
 */
function rateLimit({ max, windowMs, keyFn, message } = {}) {
  const getKey = keyFn || ((req) => req.ip || req.headers['x-forwarded-for'] || 'anonymous');
  const errorMsg = message || 'Too many requests, please slow down';

  return (req, res, next) => {
    const key = getKey(req);
    prune(key, windowMs);
    const list = buckets.get(key) || [];
    if (list.length >= max) {
      const oldestAgeMs = Date.now() - list[0];
      const retryAfterSec = Math.ceil((windowMs - oldestAgeMs) / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfterSec)));
      return res.status(429).json({
        error: errorMsg,
        code: 'RATE_LIMITED',
        retryAfter: retryAfterSec,
      });
    }
    list.push(Date.now());
    buckets.set(key, list);
    next();
  };
}

/**
 * Directly consume `n` tickets from a limiter bucket without going through
 * the middleware. Used by batch endpoints (e.g. batch-send) that enqueue
 * many sends in one HTTP request: each recipient reserves one ticket from
 * the same sliding window the per-send middleware draws from (same `key`),
 * so batches can't sidestep the cap. All-or-nothing: either all `n` fit in
 * the window or none are taken.
 *
 * Returns { allowed, remaining, retryAfterSec? }.
 */
function consume({ key, n = 1, max, windowMs }) {
  prune(key, windowMs);
  const list = buckets.get(key) || [];
  if (list.length + n > max) {
    const oldestAgeMs = list.length ? Date.now() - list[0] : 0;
    return {
      allowed: false,
      remaining: Math.max(0, max - list.length),
      retryAfterSec: Math.max(1, Math.ceil((windowMs - oldestAgeMs) / 1000)),
    };
  }
  const now = Date.now();
  for (let i = 0; i < n; i++) list.push(now);
  buckets.set(key, list);
  return { allowed: true, remaining: max - list.length };
}

/**
 * Periodic cleanup of stale entries (runs every 10 min).
 * Called automatically when this module is loaded.
 */
setInterval(() => {
  const now = Date.now();
  // Assume no sensible window is longer than 1 hour
  for (const [key, list] of buckets) {
    if (list.length === 0 || list[list.length - 1] < now - 60 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}, 10 * 60 * 1000).unref?.();

/**
 * Inspect current state (for debugging / status endpoint).
 */
function status() {
  return {
    totalKeys: buckets.size,
    totalRequests: Array.from(buckets.values()).reduce((a, b) => a + b.length, 0),
  };
}

// When REDIS_URL is set, transparently swap to the Redis-backed rate
// limiter so multi-replica Cloud Run can't oversubscribe. Without it we
// stay on the in-process bucket (single-replica only).
let exportedRateLimit = rateLimit;
let exportedStatus = status;
let exportedConsume = consume;
if (process.env.REDIS_URL) {
  try {
    const redis = require('./redis-rate-limit');
    exportedRateLimit = redis.rateLimit;
    exportedStatus = redis.status;
    exportedConsume = redis.consume;
    console.log('[rate-limit] Using Redis-backed limiter');
  } catch (e) {
    console.warn('[rate-limit] Redis init failed, falling back to in-process:', e.message);
  }
}

module.exports = {
  rateLimit: (...args) => exportedRateLimit(...args),
  status: (...args) => exportedStatus(...args),
  // consume() is sync in-process and async on Redis — callers should await it.
  consume: (...args) => exportedConsume(...args),
};
