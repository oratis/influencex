/**
 * X (Twitter) discovery via Apify.
 *
 * Skeleton — mirrors instagram-discovery.js / tiktok-discovery.js shape so
 * the discovery dispatcher can call this uniformly. Off the critical path of
 * Phase A; ships with the registry hookup + tests so the module is ready
 * when Phase B turns it on.
 *
 * Default actor: apify/twitter-scraper-lite (free tier supports keyword
 * search + author info).
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const ACTOR_ID = process.env.APIFY_X_ACTOR_ID || 'apify/twitter-scraper-lite';

function keywordToQueries(keyword) {
  if (!keyword) return [];
  return keyword.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
}

function scoreCreator(c) {
  // Same shape as IG/TikTok scoring: posts + reach + verification signal.
  let score = (c.posts || 1) * 10;
  if (c.followers > 10000) score += Math.log10(c.followers) * 20;
  if (c.verified) score += 50;
  return Math.round(score);
}

async function searchXKeyword({ keywords, maxResults = 50, minSubscribers = 1000, workspaceId } = {}) {
  if (!apify.isConfigured()) {
    return { success: false, error: 'APIFY_TOKEN not configured' };
  }
  const queries = keywordToQueries(keywords);
  if (queries.length === 0) return { success: false, error: 'No usable queries from keywords' };

  const perQuery = Math.max(20, Math.ceil(maxResults / queries.length) * 2);
  const creators = new Map();

  for (const q of queries) {
    const check = quota.canCall(ACTOR_ID, perQuery, workspaceId);
    if (!check.allowed) {
      console.warn(`[x-discovery] skipped query "${q}" — quota exhausted (${check.reason})`);
      break;
    }
    const result = await apify.runActor(ACTOR_ID, {
      searchTerms: [q],
      maxItems: perQuery,
    }, { workspaceId });

    if (!result.success) {
      console.warn(`[x-discovery] query "${q}" failed:`, result.error);
      continue;
    }
    quota.record(ACTOR_ID, result.items?.length || 0, workspaceId);

    for (const tweet of result.items || []) {
      const author = tweet.author || tweet.user || {};
      const handle = author.userName || author.screen_name;
      if (!handle) continue;
      const followers = author.followers || author.followers_count || 0;
      if (followers < minSubscribers) continue;

      const existing = creators.get(handle);
      if (existing) {
        existing.posts += 1;
      } else {
        creators.set(handle, {
          platform: 'x',
          username: handle,
          display_name: author.name || handle,
          avatar_url: author.profilePictureUrl || author.profile_image_url || '',
          followers,
          following: author.following || author.friends_count || 0,
          posts: 1,
          verified: !!author.isVerified || !!author.verified,
          profile_url: `https://twitter.com/${handle}`,
          bio: author.description || '',
        });
      }
    }
  }

  const ranked = Array.from(creators.values())
    .map(c => ({ ...c, score: scoreCreator(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return { success: true, creators: ranked, queriesSearched: queries };
}

module.exports = { searchXKeyword, keywordToQueries, scoreCreator, ACTOR_ID };
