/**
 * clockworks/free-tiktok-scraper — hashtag discovery (free tier).
 */
module.exports = {
  actorId: 'clockworks/free-tiktok-scraper',
  platform: 'tiktok',
  kind: 'discovery',
  costPerRunUsd: 0,

  buildInput({ hashtag, limit = 50 }) {
    return {
      hashtags: [String(hashtag).replace(/^#/, '')],
      resultsPerPage: limit,
      shouldDownloadVideos: false,
    };
  },

  normalize(item) {
    if (!item) return null;
    const author = item.authorMeta || {};
    if (!author.name) return null;
    return {
      platform: 'tiktok',
      username: author.name,
      display_name: author.nickName || author.name,
      avatar_url: author.avatar || '',
      followers: author.fans || 0,
      video_url: item.webVideoUrl,
      caption: item.text,
      plays: item.playCount || 0,
      likes: item.diggCount || 0,
    };
  },
};
