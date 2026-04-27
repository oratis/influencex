/**
 * KOL profile cache. Skips redundant Apify calls when the same `(platform,
 * username)` was scraped within the TTL window. Roadmap §4.4.
 *
 * Wire-in is conservative: scraper.js calls `lookup()` first; on miss it does
 * the real scrape and calls `put()` with the result. Cache is process-agnostic
 * (DB-backed), so multi-replica setups still benefit.
 *
 * Stale rows are reaped opportunistically on lookup; no explicit cron needed.
 */

const { v4: uuidv4 } = require('uuid');

const TTL_DAYS = parseInt(process.env.KOL_PROFILE_CACHE_TTL_DAYS) || 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

function keyOf(platform, username) {
  return `${String(platform || '').toLowerCase()}:${String(username || '').replace(/^@/, '').toLowerCase()}`;
}

async function lookup({ queryOne, exec }, platform, username) {
  if (!platform || !username) return null;
  const cleanUser = String(username).replace(/^@/, '').toLowerCase();
  const cleanPlatform = String(platform).toLowerCase();
  try {
    const row = await queryOne(
      `SELECT id, profile_data, source, expires_at FROM kol_profile_cache
       WHERE platform = ? AND username = ? LIMIT 1`,
      [cleanPlatform, cleanUser]
    );
    if (!row) return null;
    const expired = new Date(row.expires_at) < new Date();
    if (expired) {
      // Opportunistic cleanup; ignore failures.
      try { await exec('DELETE FROM kol_profile_cache WHERE id = ?', [row.id]); } catch {}
      return null;
    }
    let data;
    try { data = JSON.parse(row.profile_data); } catch { return null; }
    return { data, source: row.source || 'cache' };
  } catch (e) {
    // If the cache table doesn't exist yet (migration pending) we silently
    // miss — caller will hit the live scraper and try to put() which will
    // also no-op safely.
    return null;
  }
}

async function put({ exec }, platform, username, profileData, source = 'apify') {
  if (!platform || !username || !profileData) return;
  const cleanUser = String(username).replace(/^@/, '').toLowerCase();
  const cleanPlatform = String(platform).toLowerCase();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  try {
    // Delete-then-insert: simpler than UPSERT across SQLite + Postgres.
    await exec(
      'DELETE FROM kol_profile_cache WHERE platform = ? AND username = ?',
      [cleanPlatform, cleanUser]
    );
    await exec(
      `INSERT INTO kol_profile_cache (id, platform, username, profile_data, source, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), cleanPlatform, cleanUser, JSON.stringify(profileData), source, expiresAt]
    );
  } catch (e) {
    console.warn('[kol-profile-cache] put failed:', e.message);
  }
}

async function evict({ exec }, platform, username) {
  if (!platform || !username) return;
  try {
    await exec(
      'DELETE FROM kol_profile_cache WHERE platform = ? AND username = ?',
      [String(platform).toLowerCase(), String(username).replace(/^@/, '').toLowerCase()]
    );
  } catch (e) {
    console.warn('[kol-profile-cache] evict failed:', e.message);
  }
}

module.exports = { lookup, put, evict, keyOf, TTL_DAYS };
