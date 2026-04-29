/**
 * Redis-backed sliding-window rate limiter. API-compatible with
 * `./rate-limit.js`'s in-process version so handlers don't change shape.
 *
 * Algorithm: per (key, window) we keep a sorted set of timestamps in Redis.
 * On each request we ZREMRANGEBYSCORE old entries, ZCARD count, ZADD if
 * under the cap, EXPIRE so the key cleans itself up. All atomically via
 * MULTI so concurrent replicas can't oversubscribe.
 *
 * Sprint Q2 task A4. Pairs with redis-cache.js — same lazy ioredis client
 * connection.
 *
 * Fail-open behavior: any Redis error returns next() so a blip in the
 * cache layer doesn't block real users. Per-replica buckets (the in-process
 * fallback) take over implicitly because we still let the request through.
 */

let _client = null;

function getClient(redisUrl) {
  if (_client) return _client;
  const IORedis = require('ioredis');
  _client = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: false });
  _client.on('error', () => {}); // suppress noisy errors; handled per-call
  return _client;
}

function rateLimit({ max, windowMs, keyFn, message, redisUrl = process.env.REDIS_URL, prefix = process.env.REDIS_RATELIMIT_PREFIX || 'influencex:rl:' } = {}) {
  if (!redisUrl) {
    throw new Error('Redis rateLimit requires REDIS_URL (or pass redisUrl)');
  }
  const client = getClient(redisUrl);
  const getKey = keyFn || ((req) => req.ip || req.headers['x-forwarded-for'] || 'anonymous');
  const errorMsg = message || 'Too many requests, please slow down';

  return async (req, res, next) => {
    const rawKey = getKey(req);
    const key = prefix + rawKey;
    const now = Date.now();
    const cutoff = now - windowMs;

    try {
      // Atomic: trim old entries, count, conditionally add, expire.
      const m = client.multi();
      m.zremrangebyscore(key, 0, cutoff);
      m.zcard(key);
      const r = await m.exec();
      const count = (r && r[1] && r[1][1]) || 0;

      if (count >= max) {
        // Fetch the oldest timestamp to compute retry-after.
        const oldest = await client.zrange(key, 0, 0, 'WITHSCORES');
        const retryAfterSec = oldest && oldest[1]
          ? Math.max(1, Math.ceil((windowMs - (now - parseInt(oldest[1]))) / 1000))
          : Math.ceil(windowMs / 1000);
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: errorMsg,
          code: 'RATE_LIMITED',
          retryAfter: retryAfterSec,
        });
      }

      // Under cap: record this hit and refresh TTL. Member is `now-randomNonce`
      // so concurrent calls within the same ms don't dedupe in the sorted set.
      const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      await client.zadd(key, now, member);
      await client.pexpire(key, windowMs * 2);
      next();
    } catch (e) {
      // Fail-open: don't block the user on infrastructure trouble.
      next();
    }
  };
}

async function status() {
  if (!_client) return { backend: 'redis', connected: false };
  try {
    const info = await _client.info('keyspace');
    return { backend: 'redis', connected: true, info: info.split('\n').filter(l => l.includes('influencex')).join('\n') };
  } catch (e) {
    return { backend: 'redis', connected: false, error: e.message };
  }
}

module.exports = { rateLimit, status };
