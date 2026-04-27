/**
 * apify/instagram-hashtag-scraper — finds posts under a hashtag, used for
 * discovery. Returns posts with author info we use to surface candidate KOLs.
 */
module.exports = {
  actorId: 'apify/instagram-hashtag-scraper',
  platform: 'instagram',
  kind: 'discovery',
  costPerRunUsd: 0.005,

  buildInput({ hashtag, limit = 50 }) {
    return {
      hashtags: [String(hashtag).replace(/^#/, '')],
      resultsLimit: limit,
      resultsType: 'posts',
    };
  },

  normalize(item) {
    if (!item) return null;
    // The hashtag scraper returns posts; we extract the author for discovery.
    const owner = item.ownerUsername || item.owner?.username;
    if (!owner) return null;
    return {
      platform: 'instagram',
      username: owner,
      display_name: item.owner?.full_name || owner,
      avatar_url: item.owner?.profile_pic_url || '',
      followers: item.owner?.followers_count || 0,
      post_url: item.url,
      caption: item.caption,
      likes: item.likesCount || 0,
      comments: item.commentsCount || 0,
    };
  },
};
