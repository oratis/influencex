/**
 * clockworks/tiktok-scraper — single profile mode.
 */
module.exports = {
  actorId: 'clockworks/tiktok-scraper',
  platform: 'tiktok',
  kind: 'profile',
  costPerRunUsd: 0.005,

  buildInput({ url, username }) {
    const profileUrl = url || `https://www.tiktok.com/@${String(username || '').replace(/^@/, '')}`;
    return { profiles: [profileUrl], resultsPerPage: 1, shouldDownloadVideos: false };
  },

  normalize(item) {
    if (!item) return null;
    const author = item.authorMeta || item;
    return {
      platform: 'tiktok',
      username: author.name || author.uniqueId || '',
      display_name: author.nickName || author.nickname || author.name,
      avatar_url: author.avatar || author.avatarLarger || '',
      followers: author.fans || author.followerCount || 0,
      following: author.following || author.followingCount || 0,
      total_videos: author.video || author.videoCount || 0,
      bio: author.signature || '',
      profile_url: `https://www.tiktok.com/@${author.name || author.uniqueId}`,
      verified: !!author.verified,
    };
  },
};
