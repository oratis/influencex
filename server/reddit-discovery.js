/**
 * Reddit discovery via Apify.
 *
 * Skeleton — mirrors instagram-discovery.js / tiktok-discovery.js. Ships with
 * the dispatcher hookup but is not turned on by default until Phase B.
 *
 * Default actor: apify/reddit-scraper-lite (subreddit + search modes).
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper-lite';

function keywordToSubreddits(keyword) {
  if (!keyword) return [];
  // Reddit search accepts free-form text or "subreddit:foo" qualifiers.
  // We just split on commas; deeper subreddit-mapping can come later.
  return keyword.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
}

function scoreCreator(c) {
  let score = (c.posts || 1) * 10;
  if (c.karma > 1000) score += Math.log10(c.karma) * 20;
  if (c.gilded) score += 30;
  return Math.round(score);
}

async function searchRedditKeyword({ keywords, maxResults = 50, minSubscribers = 100, workspaceId } = {}) {
  if (!apify.isConfigured()) {
    return { success: false, error: 'APIFY_TOKEN not configured' };
  }
  const terms = keywordToSubreddits(keywords);
  if (terms.length === 0) return { success: false, error: 'No usable terms from keywords' };

  const perTerm = Math.max(20, Math.ceil(maxResults / terms.length) * 2);
  const creators = new Map();

  for (const t of terms) {
    const check = quota.canCall(ACTOR_ID, perTerm, workspaceId);
    if (!check.allowed) {
      console.warn(`[reddit-discovery] skipped "${t}" — quota exhausted (${check.reason})`);
      break;
    }
    const result = await apify.runActor(ACTOR_ID, {
      searches: [t],
      maxItems: perTerm,
      type: 'post',
    }, { workspaceId });

    if (!result.success) {
      console.warn(`[reddit-discovery] "${t}" failed:`, result.error);
      continue;
    }
    quota.record(ACTOR_ID, result.items?.length || 0, workspaceId);

    for (const post of result.items || []) {
      const handle = post.author || post.username;
      if (!handle || handle === '[deleted]') continue;
      const karma = post.authorKarma || post.author_karma || 0;
      if (karma < minSubscribers) continue;

      const existing = creators.get(handle);
      if (existing) {
        existing.posts += 1;
      } else {
        creators.set(handle, {
          platform: 'reddit',
          username: handle,
          display_name: handle,
          avatar_url: '',
          karma,
          posts: 1,
          gilded: !!post.gilded,
          profile_url: `https://www.reddit.com/user/${handle}`,
          bio: '',
        });
      }
    }
  }

  const ranked = Array.from(creators.values())
    .map(c => ({ ...c, score: scoreCreator(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return { success: true, creators: ranked, termsSearched: terms };
}

module.exports = { searchRedditKeyword, keywordToSubreddits, scoreCreator, ACTOR_ID };
