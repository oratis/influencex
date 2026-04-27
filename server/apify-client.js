/**
 * Apify API client for Instagram and TikTok scraping.
 *
 * Apify (https://apify.com) is a scraping platform with pay-per-run pricing.
 * Actors used:
 *   - apify/instagram-profile-scraper
 *   - clockworks/tiktok-scraper (or equivalent)
 *
 * Set APIFY_TOKEN to enable. If unset, all methods return
 *   { success: false, error: 'Apify not configured' }
 * so the caller can fall back to their existing scraper.
 *
 * All API calls use the synchronous run-actor endpoint (returns results
 * in the same HTTP response) to keep call semantics simple. For very slow
 * actors, switch to the async pattern with dataset polling.
 */

const fetch = require('./proxy-fetch');
const { v4: uuidv4 } = require('uuid');
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const DEFAULT_TIMEOUT_MS = 60_000;

function isConfigured() {
  return !!APIFY_TOKEN;
}

// Try to require database lazily so unit tests can mock or skip.
// Returns a thin facade: { exec(sql, params), available: bool }
function getPersistence() {
  try {
    const { exec } = require('./database');
    return { exec, available: true };
  } catch {
    return { exec: () => {}, available: false };
  }
}

async function persistRunStart(persistence, runRow) {
  if (!persistence.available) return;
  try {
    await persistence.exec(
      `INSERT INTO apify_runs (id, workspace_id, actor_id, status, input_payload, started_at)
       VALUES (?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)`,
      [runRow.id, runRow.workspaceId || null, runRow.actorId, JSON.stringify(runRow.input || {}).slice(0, 4000)]
    );
  } catch (e) {
    // Persistence failures must NEVER break the actual scrape.
    console.warn('[apify] persistence start failed:', e.message);
  }
}

async function persistRunFinish(persistence, id, patch) {
  if (!persistence.available) return;
  try {
    await persistence.exec(
      `UPDATE apify_runs SET status=?, duration_ms=?, result_summary=?, error_message=?, finished_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [patch.status, patch.durationMs || null, patch.resultSummary || null, patch.errorMessage || null, id]
    );
  } catch (e) {
    console.warn('[apify] persistence finish failed:', e.message);
  }
}

async function runActor(actorId, input, { timeoutMs = DEFAULT_TIMEOUT_MS, workspaceId, persistence } = {}) {
  if (!isConfigured()) {
    return { success: false, error: 'Apify not configured (set APIFY_TOKEN)' };
  }

  const persist = persistence || getPersistence();
  const runId = uuidv4();
  const startedAt = Date.now();
  await persistRunStart(persist, { id: runId, workspaceId, actorId, input });

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${Math.floor(timeoutMs / 1000)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errMsg = `Apify returned ${res.status}: ${text.slice(0, 200)}`;
      await persistRunFinish(persist, runId, {
        status: res.status === 408 ? 'timeout' : 'failed',
        durationMs: Date.now() - startedAt,
        errorMessage: errMsg,
      });
      return { success: false, error: errMsg, runId };
    }

    const data = await res.json();
    const items = Array.isArray(data) ? data : [data];
    await persistRunFinish(persist, runId, {
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      resultSummary: JSON.stringify({ itemCount: items.length }),
    });
    return { success: true, items, runId };
  } catch (e) {
    const aborted = e.name === 'AbortError';
    await persistRunFinish(persist, runId, {
      status: aborted ? 'timeout' : 'failed',
      durationMs: Date.now() - startedAt,
      errorMessage: e.message,
    });
    return { success: false, error: e.message, runId };
  }
}

/**
 * Scrape an Instagram profile.
 * Returns a normalized KOL object or { success: false }.
 */
async function scrapeInstagram(username, opts = {}) {
  const clean = username.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').split('/')[0];
  if (!clean) return { success: false, error: 'Invalid Instagram username' };

  const result = await runActor('apify/instagram-profile-scraper', {
    usernames: [clean],
    resultsLimit: 1,
  }, { workspaceId: opts.workspaceId });

  if (!result.success) return result;
  const profile = result.items?.[0];
  if (!profile) return { success: false, error: 'Instagram profile not found' };

  return {
    success: true,
    platform: 'instagram',
    username: profile.username || clean,
    display_name: profile.fullName || profile.username,
    avatar_url: profile.profilePicUrlHD || profile.profilePicUrl,
    followers: profile.followersCount || 0,
    following: profile.followsCount || 0,
    total_videos: profile.postsCount || 0,
    bio: profile.biography || '',
    profile_url: `https://www.instagram.com/${profile.username || clean}/`,
    verified: !!profile.verified,
    email: extractEmailFromText(profile.biography || ''),
  };
}

/**
 * Scrape a TikTok profile. Tries clockworks/tiktok-scraper first.
 */
async function scrapeTikTok(url, opts = {}) {
  const profileUrl = /^https?:/.test(url) ? url : `https://www.tiktok.com/@${url.replace(/^@/, '')}`;

  const result = await runActor('clockworks/tiktok-scraper', {
    profiles: [profileUrl],
    resultsPerPage: 1,
    shouldDownloadVideos: false,
  }, { workspaceId: opts.workspaceId });

  if (!result.success) return result;
  const profile = result.items?.[0];
  if (!profile) return { success: false, error: 'TikTok profile not found' };

  const author = profile.authorMeta || profile;
  return {
    success: true,
    platform: 'tiktok',
    username: author.name || author.uniqueId || '',
    display_name: author.nickName || author.nickname || author.name,
    avatar_url: author.avatar || author.avatarLarger,
    followers: author.fans || author.followerCount || 0,
    following: author.following || author.followingCount || 0,
    total_videos: author.video || author.videoCount || 0,
    bio: author.signature || '',
    profile_url: profileUrl,
    verified: !!author.verified,
    email: extractEmailFromText(author.signature || ''),
  };
}

// Simple email regex — matches most business emails
function extractEmailFromText(text) {
  if (!text) return null;
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

module.exports = {
  isConfigured,
  scrapeInstagram,
  scrapeTikTok,
  runActor,
};
