/**
 * Instagram discovery via Apify hashtag scraper.
 *
 * Strategy: take the user's keyword(s), turn each into a hashtag, run the
 * apify/instagram-hashtag-scraper actor to pull recent top posts under that
 * tag, and aggregate the unique authors. Results are scored by post count +
 * engagement signals so the most relevant creators surface first.
 *
 * We deliberately do NOT do a full per-profile scrape here — the pipeline's
 * scrape stage (server/scraper.js) handles that downstream, only for KOLs the
 * user actually approves. This keeps Apify cost proportional to user intent
 * rather than to candidate volume.
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const ACTOR_ID = 'apify/instagram-hashtag-scraper';

/**
 * Convert a keyword phrase into one or more hashtag tokens. The hashtag
 * scraper accepts plain alphanumeric strings (no '#'), one per search.
 */
function keywordToHashtags(keyword) {
  if (!keyword) return [];
  // Split on commas first — comma is the canonical multi-keyword separator
  // in our discovery UI. Inside one segment, collapse spaces (Instagram
  // hashtags can't contain whitespace).
  return keyword
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .slice(0, 5); // cap searches per call to limit cost
}

/**
 * Score a creator by how many of the searched hashtags they appear under and
 * by aggregate engagement (likes + comments) on the matched posts. Caller
 * passes the bucket of posts attributed to this creator.
 */
function scoreCreator(posts, hashtagsMatched) {
  const totalEngagement = posts.reduce(
    (sum, p) => sum + (p.likesCount || 0) + (p.commentsCount || 0),
    0
  );
  // Engagement contribution: log scale so a 1M-like post doesn't dominate.
  const engBoost = Math.min(40, Math.log10(Math.max(1, totalEngagement)) * 8);
  // Hashtag match contribution: 20 per matched tag, capped at 60.
  const tagBoost = Math.min(60, hashtagsMatched.size * 20);
  return Math.round(Math.min(100, tagBoost + engBoost));
}

/**
 * Search Instagram for KOL candidates by keyword/hashtag.
 *
 * Returns the same shape as youtube-discovery so the dispatcher can merge
 * results across platforms transparently.
 */
async function searchInstagramHashtag({ keywords, maxResults = 50, minSubscribers = 1000, workspaceId } = {}) {
  if (!apify.isConfigured()) {
    return { success: false, error: 'APIFY_TOKEN not configured' };
  }

  const hashtags = keywordToHashtags(keywords);
  if (hashtags.length === 0) {
    return { success: false, error: 'No usable hashtags from keywords' };
  }

  // Allocate per-tag pull such that total stays under maxResults.
  const perTag = Math.max(20, Math.ceil(maxResults / hashtags.length) * 2);
  // Map of username → { posts, hashtagsMatched, latestProfileSnapshot }
  const creators = new Map();

  for (const tag of hashtags) {
    const check = quota.canCall(ACTOR_ID, perTag, workspaceId);
    if (!check.allowed) {
      console.warn(`[apify-quota] Instagram discovery skipped for #${tag} — quota exhausted (${check.reason}; runs ${check.runs}/${check.runLimit}, items ${check.items}/${check.itemsLimit})`);
      break;
    }

    const result = await apify.runActor(ACTOR_ID, {
      hashtags: [tag],
      resultsLimit: perTag,
      resultsType: 'posts',
    }, { workspaceId });

    if (!result.success) {
      console.warn(`[ig-discovery] hashtag #${tag} failed:`, result.error);
      continue;
    }
    quota.record(ACTOR_ID, result.items?.length || 0, workspaceId);

    for (const post of (result.items || [])) {
      const username = post.ownerUsername || post.owner?.username;
      if (!username) continue;
      if (!creators.has(username)) {
        creators.set(username, {
          username,
          display_name: post.ownerFullName || post.owner?.fullName || username,
          followers: post.ownerFollowersCount || post.owner?.followersCount || 0,
          avatar_url: post.ownerProfilePicUrl || post.owner?.profilePicUrl || '',
          bio: post.ownerBiography || post.owner?.biography || '',
          posts: [],
          hashtagsMatched: new Set(),
        });
      }
      const c = creators.get(username);
      c.posts.push(post);
      c.hashtagsMatched.add(tag);
      // Some hashtag-scraper responses don't include follower counts on every
      // post — keep the highest sighting we've seen.
      const seenFollowers = post.ownerFollowersCount || post.owner?.followersCount || 0;
      if (seenFollowers > c.followers) c.followers = seenFollowers;
    }

    // Be kind to Apify between calls.
    await new Promise(r => setTimeout(r, 200));
  }

  const channels = [...creators.values()]
    // The hashtag scraper doesn't always return follower counts. Treat a
    // 0-follower row as "unknown" rather than filtering it out — the scrape
    // stage downstream will fill in the real number.
    .filter(c => c.followers === 0 || c.followers >= minSubscribers)
    .map(c => ({
      channelId: c.username,
      platform: 'instagram',
      channel_url: `https://www.instagram.com/${c.username}/`,
      channel_name: c.display_name,
      avatar_url: c.avatar_url,
      description: c.bio.slice(0, 300),
      subscribers: c.followers,
      total_videos: c.posts.length,
      relevance_score: scoreCreator(c.posts, c.hashtagsMatched),
      category: '', // detection happens in the pipeline scrape stage
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score || b.subscribers - a.subscribers)
    .slice(0, maxResults);

  return { success: true, channels, total: channels.length };
}

module.exports = { searchInstagramHashtag, keywordToHashtags, scoreCreator };
