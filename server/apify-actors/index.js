/**
 * Apify actor registry.
 *
 * Each entry describes one Apify actor we use:
 *   - actorId: the slug Apify expects in /v2/acts/<slug>/...
 *   - kind: 'profile' | 'discovery' | 'comments' | 'reviews' | 'ads'
 *   - costPerRunUsd: rough estimate (used for ops dashboards; Apify may bill differently)
 *   - normalize(rawDatasetItem, opts) → unified KOL/post/comment shape
 *   - buildInput(opts) → input payload for runActor()
 *
 * Adding a new actor = drop a new file in this folder + register it here.
 * Roadmap §4.3.
 */

const instagramProfile = require('./instagram-profile');
const instagramHashtag = require('./instagram-hashtag');
const tiktokProfile = require('./tiktok-profile');
const tiktokHashtag = require('./tiktok-hashtag');
const youtubeChannel = require('./youtube-channel');

const ACTORS = {
  [instagramProfile.actorId]: instagramProfile,
  [instagramHashtag.actorId]: instagramHashtag,
  [tiktokProfile.actorId]: tiktokProfile,
  [tiktokHashtag.actorId]: tiktokHashtag,
  [youtubeChannel.actorId]: youtubeChannel,
};

function get(actorId) {
  return ACTORS[actorId] || null;
}

function list() {
  return Object.values(ACTORS).map(a => ({
    actorId: a.actorId,
    kind: a.kind,
    platform: a.platform,
    costPerRunUsd: a.costPerRunUsd || 0,
  }));
}

module.exports = { get, list, ACTORS };
