/**
 * apify/youtube-channel-scraper — channel-level data when YT Data API quota is
 * exhausted or unavailable. Currently we prefer the official API (free, fast),
 * so this is registered as a fallback for Phase B / heavier campaigns.
 */
module.exports = {
  actorId: 'apify/youtube-channel-scraper',
  platform: 'youtube',
  kind: 'profile',
  costPerRunUsd: 0.005,

  buildInput({ channelUrl, channelHandle }) {
    return {
      startUrls: channelUrl ? [{ url: channelUrl }] : [{ url: `https://www.youtube.com/@${channelHandle}` }],
      maxResults: 1,
    };
  },

  normalize(item) {
    if (!item) return null;
    return {
      platform: 'youtube',
      username: item.channelHandle || item.channelName,
      display_name: item.channelName,
      avatar_url: item.channelAvatarUrl || '',
      followers: item.numberOfSubscribers || 0,
      total_videos: item.numberOfVideos || 0,
      bio: item.channelDescription || '',
      profile_url: item.channelUrl,
      verified: !!item.isChannelVerified,
    };
  },
};
