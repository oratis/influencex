/**
 * TikTok discovery via Apify hashtag scraper.
 *
 * Mirrors instagram-discovery.js: keyword(s) → hashtags → recent videos under
 * each tag → unique authors aggregated and scored. We pick clockworks/
 * free-tiktok-scraper because it accepts a hashtags input directly and is
 * cheaper than the paid clockworks/tiktok-scraper for this use case.
 *
 * Per-profile detail (engagement rate, avg views, video list) is filled in
 * later by the pipeline's scrape stage — discovery only needs enough signal
 * to rank candidates.
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const ACTOR_ID = 'clockworks/free-tiktok-scraper';

function keywordToHashtags(keyword) {
  if (!keyword) return [];
  return keyword
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .slice(0, 5);
}

function scoreCreator(videos, hashtagsMatched) {
  const totalEngagement = videos.reduce(
    (sum, v) => sum + (v.diggCount || v.likes || 0) + (v.commentCount || v.comments || 0) + (v.shareCount || v.shares || 0),
    0
  );
  const engBoost = Math.min(40, Math.log10(Math.max(1, totalEngagement)) * 8);
  const tagBoost = Math.min(60, hashtagsMatched.size * 20);
  return Math.round(Math.min(100, tagBoost + engBoost));
}

async function searchTikTokHashtag({ keywords, maxResults = 50, minSubscribers = 1000, workspaceId } = {}) {
  if (!apify.isConfigured()) {
    return { success: false, error: 'APIFY_TOKEN not configured' };
  }

  const hashtags = keywordToHashtags(keywords);
  if (hashtags.length === 0) {
    return { success: false, error: 'No usable hashtags from keywords' };
  }

  const perTag = Math.max(20, Math.ceil(maxResults / hashtags.length) * 2);
  const creators = new Map();

  for (const tag of hashtags) {
    const check = quota.canCall(ACTOR_ID, perTag, workspaceId);
    if (!check.allowed) {
      console.warn(`[apify-quota] TikTok discovery skipped for #${tag} — quota exhausted (${check.reason}; runs ${check.runs}/${check.runLimit}, items ${check.items}/${check.itemsLimit})`);
      break;
    }

    // free-tiktok-scraper takes `hashtags` as bare strings without '#'.
    const result = await apify.runActor(ACTOR_ID, {
      hashtags: [tag],
      resultsPerPage: perTag,
      shouldDownloadVideos: false,
    }, { workspaceId });

    if (!result.success) {
      console.warn(`[tiktok-discovery] hashtag #${tag} failed:`, result.error);
      continue;
    }
    quota.record(ACTOR_ID, result.items?.length || 0, workspaceId);

    for (const video of (result.items || [])) {
      const author = video.authorMeta || video.author || {};
      const username = author.name || author.uniqueId || author.username;
      if (!username) continue;
      if (!creators.has(username)) {
        creators.set(username, {
          username,
          display_name: author.nickName || author.nickname || username,
          followers: author.fans || author.followerCount || author.followers || 0,
          avatar_url: author.avatar || author.avatarLarger || '',
          bio: author.signature || author.bio || '',
          videos: [],
          hashtagsMatched: new Set(),
        });
      }
      const c = creators.get(username);
      c.videos.push(video);
      c.hashtagsMatched.add(tag);
      const seenFollowers = author.fans || author.followerCount || author.followers || 0;
      if (seenFollowers > c.followers) c.followers = seenFollowers;
    }

    await new Promise(r => setTimeout(r, 200));
  }

  const channels = [...creators.values()]
    .filter(c => c.followers === 0 || c.followers >= minSubscribers)
    .map(c => ({
      channelId: c.username,
      platform: 'tiktok',
      channel_url: `https://www.tiktok.com/@${c.username}`,
      channel_name: c.display_name,
      avatar_url: c.avatar_url,
      description: c.bio.slice(0, 300),
      subscribers: c.followers,
      total_videos: c.videos.length,
      relevance_score: scoreCreator(c.videos, c.hashtagsMatched),
      category: '',
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score || b.subscribers - a.subscribers)
    .slice(0, maxResults);

  return { success: true, channels, total: channels.length };
}

module.exports = { searchTikTokHashtag, keywordToHashtags, scoreCreator };
