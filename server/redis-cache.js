/**
 * Redis-backed cache. API-compatible with `./cache.js`'s in-memory cache so
 * callers don't need to know which backend is running.
 *
 *   get(key)                        — value | undefined
 *   set(key, value, ttlMs?)         — JSON-serializes value
 *   delete(key) / clear() / remember(key, fn, ttlMs)
 *   getStats()                      — local counters (hits/misses/sets)
 *
 * Sprint Q2 task A4. Pairs with bullmq-queue.js — when REDIS_URL is set,
 * cache, rate-limit, and queue all migrate to Redis at once.
 *
 * On any Redis error this module fails-open: get/set become no-ops, the
 * caller behaves as if there's no cache. We never let infrastructure
 * failures cascade into business-logic failures.
 */

function createRedisCache({
  redisUrl = process.env.REDIS_URL,
  prefix = process.env.REDIS_CACHE_PREFIX || 'influencex:cache:',
  defaultTtlMs = 5 * 60 * 1000,
} = {}) {
  if (!redisUrl) {
    throw new Error('createRedisCache requires REDIS_URL (or pass redisUrl)');
  }

  const IORedis = require('ioredis');
  const client = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: false });
  let connected = false;
  client.on('ready', () => { connected = true; });
  client.on('error', (e) => { /* fail-open; we surface via stats only */ stats.errors++; if (process.env.DEBUG_REDIS) console.warn('[redis-cache]', e.message); });
  client.on('end', () => { connected = false; });

  const stats = { hits: 0, misses: 0, sets: 0, errors: 0 };

  function k(key) { return prefix + String(key); }

  async function get(key) {
    try {
      const raw = await client.get(k(key));
      if (raw == null) { stats.misses++; return undefined; }
      stats.hits++;
      return JSON.parse(raw);
    } catch (e) { stats.errors++; stats.misses++; return undefined; }
  }

  async function set(key, value, ttlMs) {
    try {
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
      await client.set(k(key), JSON.stringify(value), 'PX', ttl);
      stats.sets++;
    } catch (e) { stats.errors++; }
  }

  async function del(key) {
    try { await client.del(k(key)); }
    catch { stats.errors++; }
  }

  async function clear() {
    // Best-effort SCAN+DEL since FLUSHALL is too dangerous on a shared Redis.
    try {
      const stream = client.scanStream({ match: prefix + '*', count: 200 });
      for await (const keys of stream) {
        if (keys.length) await client.del(...keys);
      }
    } catch { stats.errors++; }
  }

  async function remember(key, fn, ttlMs) {
    const cached = await get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    await set(key, value, ttlMs);
    return value;
  }

  function getStats() {
    return { ...stats, backend: 'redis', connected, prefix };
  }

  async function close() {
    try { await client.quit(); } catch {}
  }

  return { get, set, delete: del, clear, remember, getStats, close };
}

module.exports = { createRedisCache };
