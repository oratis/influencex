/**
 * apify/instagram-profile-scraper — fetches a single IG user's profile.
 * Pricing: ~$2.30 per 1000 profiles.
 */
module.exports = {
  actorId: 'apify/instagram-profile-scraper',
  platform: 'instagram',
  kind: 'profile',
  costPerRunUsd: 0.0023,

  buildInput({ username }) {
    const clean = String(username || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').split('/')[0];
    return { usernames: [clean], resultsLimit: 1 };
  },

  normalize(item) {
    if (!item) return null;
    return {
      platform: 'instagram',
      username: item.username,
      display_name: item.fullName || item.username,
      avatar_url: item.profilePicUrlHD || item.profilePicUrl || '',
      followers: item.followersCount || 0,
      following: item.followsCount || 0,
      total_videos: item.postsCount || 0,
      bio: item.biography || '',
      profile_url: `https://www.instagram.com/${item.username}/`,
      verified: !!item.verified,
      external_url: item.externalUrl || null,
    };
  },
};
