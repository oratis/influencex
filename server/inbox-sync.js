/**
 * Inbox auto-sync — periodically harvest comments from connected Instagram /
 * TikTok accounts and stash them in `inbox_messages` so users don't have to
 * paste URLs into the manual sync modal.
 *
 * Two modes:
 *  - **Polling cron** (this module): runs every INBOX_SYNC_INTERVAL_MS,
 *    iterates over `mailbox_accounts` / `platform_connections` rows whose
 *    workspace has opted in (settings.inbox_auto_sync_enabled = true), and
 *    pulls latest content URLs to feed comment-harvest.
 *  - **Manual trigger** (/api/inbox-messages/sync-apify): unchanged.
 *
 * v1 ships as a SKELETON: the cron runs, picks up workspaces with the flag,
 * but the URL discovery for IG/TikTok creator-owned posts requires the
 * platform OAuth tokens we already store in `platform_connections`. v1
 * returns no-op for workspaces that haven't shipped a recent_post_urls cache.
 * v2 will integrate apify/instagram-profile-scraper to discover the
 * workspace's own posts via OAuth-bound handle.
 *
 * Sprint Q2 task — backlog completion of Phase C (inbox).
 */

const INTERVAL_MS = parseInt(process.env.INBOX_SYNC_INTERVAL_MS) || 60 * 60 * 1000; // hourly
const MAX_WORKSPACES_PER_TICK = parseInt(process.env.INBOX_SYNC_MAX_WS_PER_TICK) || 10;
const COMMENTS_PER_POST = parseInt(process.env.INBOX_SYNC_COMMENTS_PER_POST) || 50;
const POSTS_PER_WORKSPACE = parseInt(process.env.INBOX_SYNC_POSTS_PER_WS) || 5;

let _interval = null;

// Auto-discover the workspace's own recent IG / TikTok post URLs via Apify
// profile scrape, given the connected handle from platform_connections.
// Returns { igUrls, ttUrls } — empty arrays when nothing connected or Apify
// not configured.
async function autoDiscoverPostUrls({ query }, workspaceId) {
  const apify = require('./apify-client');
  if (!apify.isConfigured()) return { igUrls: [], ttUrls: [] };
  let igUrls = [], ttUrls = [];
  try {
    const r = await query(
      `SELECT platform, account_name FROM platform_connections
       WHERE workspace_id = ? AND platform IN ('instagram', 'tiktok')`,
      [workspaceId]
    );
    for (const row of r.rows || []) {
      if (!row.account_name) continue;
      try {
        if (row.platform === 'instagram') {
          // The instagram-profile-scraper returns `latestPosts: [{ url, ... }]`
          // when called with `usernames`. Cap urls at POSTS_PER_WORKSPACE.
          const r1 = await apify.runActor('apify/instagram-profile-scraper', {
            usernames: [row.account_name],
            resultsLimit: 1,
          }, { workspaceId });
          if (r1.success) {
            const latest = (r1.items?.[0]?.latestPosts || []).map(p => p.url).filter(Boolean);
            igUrls = latest.slice(0, POSTS_PER_WORKSPACE);
          }
        } else if (row.platform === 'tiktok') {
          const r2 = await apify.runActor('clockworks/tiktok-scraper', {
            profiles: [`https://www.tiktok.com/@${row.account_name}`],
            resultsPerPage: POSTS_PER_WORKSPACE,
            shouldDownloadVideos: false,
          }, { workspaceId });
          if (r2.success) {
            ttUrls = (r2.items || []).map(it => it.webVideoUrl).filter(Boolean).slice(0, POSTS_PER_WORKSPACE);
          }
        }
      } catch (e) {
        console.warn(`[inbox-sync] auto-discover ${row.platform} failed for ${workspaceId}:`, e.message);
      }
    }
  } catch (e) {
    // platform_connections might not exist yet on a fresh sandbox — ignore.
  }
  return { igUrls, ttUrls };
}

async function tick({ exec, query, queryOne, uuidv4 }) {
  let synced = 0, errored = 0, autoDiscovered = 0;
  try {
    const r = await query(
      `SELECT id, name, settings FROM workspaces
       WHERE settings IS NOT NULL
       LIMIT ?`,
      [MAX_WORKSPACES_PER_TICK * 5]
    );
    const rows = r.rows || [];
    const enabled = rows.filter(w => {
      try {
        const s = typeof w.settings === 'string' ? JSON.parse(w.settings) : w.settings;
        return s && s.inbox_auto_sync_enabled === true;
      } catch { return false; }
    }).slice(0, MAX_WORKSPACES_PER_TICK);

    if (enabled.length === 0) return { synced, errored, autoDiscovered, workspaces_checked: 0 };

    const commentHarvest = require('./comment-harvest');

    for (const ws of enabled) {
      try {
        let settings = {};
        try { settings = typeof ws.settings === 'string' ? JSON.parse(ws.settings) : ws.settings || {}; } catch {}

        // Two URL sources: explicit settings.inbox_auto_sync_*_urls take
        // priority; otherwise we auto-discover via the connected handle.
        let igUrls = (settings.inbox_auto_sync_ig_urls || []).slice(0, POSTS_PER_WORKSPACE);
        let ttUrls = (settings.inbox_auto_sync_tt_urls || []).slice(0, POSTS_PER_WORKSPACE);

        if (igUrls.length === 0 && ttUrls.length === 0) {
          const auto = await autoDiscoverPostUrls({ query }, ws.id);
          igUrls = auto.igUrls;
          ttUrls = auto.ttUrls;
          if (igUrls.length + ttUrls.length > 0) autoDiscovered++;
        }

        if (igUrls.length > 0) {
          const r1 = await commentHarvest.harvestInstagramComments({
            postUrls: igUrls, limitPerPost: COMMENTS_PER_POST, workspaceId: ws.id,
          });
          if (r1.success) {
            for (const c of r1.comments) {
              await insertComment({ exec, queryOne, uuidv4 }, ws.id, 'instagram', c);
            }
          }
        }
        if (ttUrls.length > 0) {
          const r2 = await commentHarvest.harvestTikTokComments({
            videoUrls: ttUrls, limitPerVideo: COMMENTS_PER_POST, workspaceId: ws.id,
          });
          if (r2.success) {
            for (const c of r2.comments) {
              await insertComment({ exec, queryOne, uuidv4 }, ws.id, 'tiktok', c);
            }
          }
        }
        synced++;
      } catch (e) {
        errored++;
        console.warn('[inbox-sync] workspace', ws.id, 'failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('[inbox-sync] tick failed:', e.message);
  }
  if (synced > 0 || errored > 0) {
    console.log(`[inbox-sync] tick: ${synced} workspace(s) synced (${autoDiscovered} auto-discovered), ${errored} error(s)`);
  }
  return { synced, errored, autoDiscovered };
}

async function insertComment({ exec, queryOne, uuidv4 }, workspaceId, platform, comment) {
  if (!comment.external_id) return;
  // Idempotent insert via the existing UNIQUE(workspace_id, platform, external_id) index.
  try {
    await exec(
      `INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id,
              author_handle, author_name, text, url, occurred_at, fetched_at, raw)
       VALUES (?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [uuidv4(), workspaceId, platform, comment.external_id,
       comment.author_handle || null, comment.author_name || null, comment.body || null,
       comment.source_url || null, comment.created_at || null,
       JSON.stringify(comment).slice(0, 4000)]
    );
  } catch (e) {
    // UNIQUE violation = already synced, skip silently
    if (!/UNIQUE|duplicate/i.test(e.message)) throw e;
  }
}

function start({ exec, query, queryOne, uuidv4, intervalMs = INTERVAL_MS } = {}) {
  if (_interval) return;
  // Stagger first run so multiple cron-style modules don't fire at boot.
  setTimeout(() => tick({ exec, query, queryOne, uuidv4 }).catch(() => {}), 5_000);
  _interval = setInterval(() => tick({ exec, query, queryOne, uuidv4 }).catch(() => {}), intervalMs);
  console.log(`[inbox-sync] Started (tick every ${Math.round(intervalMs / 60000)} min)`);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { start, stop, tick, INTERVAL_MS };
