/**
 * In-memory TTL cache with stats.
 *
 * Suitable for caching expensive upstream API responses (YouTube, Hunter,
 * etc) within a single process. For multi-replica or cross-process caching,
 * swap for Redis — the get/set/delete API is identical.
 *
 * Entries are evicted lazily on access; a periodic sweep also runs every
 * 5 minutes to reclaim memory from unused keys.
 */

function createCache({ defaultTtlMs = 5 * 60 * 1000, maxKeys = 1000 } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expired: 0 };

  function isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      stats.misses += 1;
      return undefined;
    }
    if (isExpired(entry)) {
      store.delete(key);
      stats.expired += 1;
      stats.misses += 1;
      return undefined;
    }
    // LRU touch: move to end of Map
    store.delete(key);
    store.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  function set(key, value, ttlMs) {
    // Evict oldest if at capacity (Map preserves insertion order)
    if (store.size >= maxKeys && !store.has(key)) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
      stats.evictions += 1;
    }
    const ttl = ttlMs === undefined ? defaultTtlMs : ttlMs;
    const expiresAt = ttl === Infinity || ttl === null ? null : Date.now() + ttl;
    store.set(key, { value, expiresAt });
    stats.sets += 1;
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
  }

  /**
   * Get-or-compute: if key is missing/expired, run producer() and cache result.
   * Returns the cached or newly-computed value.
   */
  async function remember(key, producer, ttlMs) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    set(key, value, ttlMs);
    return value;
  }

  function getStats() {
    const total = stats.hits + stats.misses;
    return {
      ...stats,
      size: store.size,
      maxKeys,
      hitRate: total > 0 ? stats.hits / total : 0,
    };
  }

  // Periodic sweep of expired entries (every 5 min)
  const sweepTimer = setInterval(() => {
    for (const [key, entry] of store) {
      if (isExpired(entry)) {
        store.delete(key);
        stats.expired += 1;
      }
    }
  }, 5 * 60 * 1000);
  sweepTimer.unref?.();

  return { get, set, delete: del, clear, remember, getStats };
}

// Default shared cache — used by API route handlers that want "just a cache".
// When REDIS_URL is set we use the Redis-backed cache so multi-replica
// Cloud Run shares a single coherent cache. Without it we fall back to the
// in-process cache (max-instances=1 still required).
let defaultCache;
if (process.env.REDIS_URL) {
  try {
    const { createRedisCache } = require('./redis-cache');
    defaultCache = createRedisCache();
    console.log('[cache] Using Redis-backed defaultCache');
  } catch (e) {
    console.warn('[cache] Redis init failed, falling back to in-process:', e.message);
    defaultCache = createCache();
  }
} else {
  defaultCache = createCache();
}

module.exports = { createCache, defaultCache };
