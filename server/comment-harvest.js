/**
 * Comment / inbox harvesting via Apify (skeleton — Phase C).
 *
 * Pulls top comments from a given Instagram post or TikTok video URL and
 * normalizes them into the `inbox_messages` shape so the existing Community
 * Inbox UI can render them. Currently exposes module functions only —
 * dispatcher routes will be added when the Inbox UI gets the "sync from
 * Apify" action wired up.
 *
 * Default actors:
 *   - apify/instagram-comment-scraper
 *   - clockworks/tiktok-comments-scraper (or equivalent)
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const IG_ACTOR = process.env.APIFY_IG_COMMENTS_ACTOR_ID || 'apify/instagram-comment-scraper';
const TT_ACTOR = process.env.APIFY_TT_COMMENTS_ACTOR_ID || 'clockworks/tiktok-comments-scraper';

function normalizeIgComment(item, postUrl) {
  if (!item) return null;
  return {
    platform: 'instagram',
    external_id: item.id,
    author_handle: item.ownerUsername || item.owner?.username || '',
    author_name: item.owner?.full_name || item.ownerUsername || '',
    body: item.text || '',
    created_at: item.timestamp ? new Date(item.timestamp).toISOString() : null,
    likes: item.likesCount || 0,
    source_url: postUrl,
  };
}

function normalizeTtComment(item, videoUrl) {
  if (!item) return null;
  return {
    platform: 'tiktok',
    external_id: item.cid || item.id,
    author_handle: item.user?.uniqueId || item.user?.unique_id || '',
    author_name: item.user?.nickname || '',
    body: item.text || '',
    created_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : null,
    likes: item.digg_count || 0,
    source_url: videoUrl,
  };
}

async function harvestInstagramComments({ postUrls, limitPerPost = 50, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!Array.isArray(postUrls) || postUrls.length === 0) return { success: false, error: 'postUrls required' };

  const out = [];
  for (const url of postUrls.slice(0, 20)) {
    const check = quota.canCall(IG_ACTOR, limitPerPost, workspaceId);
    if (!check.allowed) {
      console.warn(`[comment-harvest] IG harvest skipped — quota exhausted (${check.reason})`);
      break;
    }
    const r = await apify.runActor(IG_ACTOR, {
      directUrls: [url],
      resultsLimit: limitPerPost,
    }, { workspaceId });
    if (!r.success) continue;
    quota.record(IG_ACTOR, r.items?.length || 0, workspaceId);
    for (const it of r.items || []) {
      const norm = normalizeIgComment(it, url);
      if (norm) out.push(norm);
    }
  }
  return { success: true, comments: out };
}

async function harvestTikTokComments({ videoUrls, limitPerVideo = 50, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!Array.isArray(videoUrls) || videoUrls.length === 0) return { success: false, error: 'videoUrls required' };

  const out = [];
  for (const url of videoUrls.slice(0, 20)) {
    const check = quota.canCall(TT_ACTOR, limitPerVideo, workspaceId);
    if (!check.allowed) {
      console.warn(`[comment-harvest] TT harvest skipped — quota exhausted (${check.reason})`);
      break;
    }
    const r = await apify.runActor(TT_ACTOR, {
      postURLs: [url],
      commentsPerPost: limitPerVideo,
    }, { workspaceId });
    if (!r.success) continue;
    quota.record(TT_ACTOR, r.items?.length || 0, workspaceId);
    for (const it of r.items || []) {
      const norm = normalizeTtComment(it, url);
      if (norm) out.push(norm);
    }
  }
  return { success: true, comments: out };
}

module.exports = {
  harvestInstagramComments,
  harvestTikTokComments,
  normalizeIgComment,
  normalizeTtComment,
  IG_ACTOR,
  TT_ACTOR,
};
