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

module.exports = { rateLimit, status };
