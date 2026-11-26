'use strict';

/**
 * TikTok connector — Content Posting API (Direct Post, PULL_FROM_URL).
 *
 * credentials: { accessToken }
 * payload:     { text (title/caption), videoUrl, privacyLevel?, disableComment?, disableDuet?, disableStitch?, coverTimestampMs?, aiGenerated?, brandContentToggle?, brandOrganicToggle? }
 *
 * Before the app passes the Content Posting audit, every post is `SELF_ONLY`,
 * the posting account itself must be set to private, and at most 5 users can
 * post through the app in 24 h. `SELF_ONLY` is the default here, so a host
 * that has NOT passed audit still gets a working (private) flow, and one that
 * has passes `privacyLevel: 'PUBLIC_TO_EVERYONE'` explicitly. The platform
 * expects the privacy options to come from /v2/post/publish/creator_info/query/
 * first: call `fetchCreatorInfo` BEFORE rendering the post page, and build the
 * privacy / comment / duet / stitch controls from what it returns. The
 * `video_url` domain must be verified in the developer portal.
 *
 * `aiGenerated` (boolean) is sent as post_info.is_aigc, TikTok's AI-generated
 * content label; omitted, the field is not sent.
 *
 * `brandContentToggle` (paid partnership / "Your brand" disclosure target is a
 * third party) and `brandOrganicToggle` (promoting the poster's own brand) are
 * always sent as booleans, default false. Branded content cannot be private,
 * so `brandContentToggle` with SELF_ONLY is rejected by validate().
 *
 * Tokens: access_token and refresh_token lifetimes follow the token response's
 * `expires_in` / `refresh_expires_in`, and the refresh_token is replaced on
 * EVERY refresh (see capabilities.tiktok.tokens). This connector only uses the
 * access token; refreshing and storing the new pair is the host's job.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps } = require('../result');

const API = 'https://open.tiktokapis.com/v2';
const PRIVACY = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
const DEFAULT_PRIVACY = 'SELF_ONLY';

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('TikTok publishing requires a public video_url (MP4). Text-only posts are not supported.');
  if ((payload.text || '').length > PLATFORMS.tiktok.text.maxLength) errors.push(`caption exceeds ${PLATFORMS.tiktok.text.maxLength} characters`);
  if (payload.privacyLevel && !PRIVACY.has(payload.privacyLevel)) errors.push(`privacyLevel must be one of ${[...PRIVACY].join(', ')}`);
  if (payload.brandContentToggle === true && (payload.privacyLevel || DEFAULT_PRIVACY) === 'SELF_ONLY') errors.push('branded content cannot be private (SELF_ONLY)');
  return errors;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('tiktok: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const privacy = payload.privacyLevel || DEFAULT_PRIVACY;
  const body = {
    post_info: {
      title: (payload.text || '').slice(0, PLATFORMS.tiktok.text.maxLength),
      privacy_level: privacy,
      disable_duet: payload.disableDuet === true,
      disable_stitch: payload.disableStitch === true,
      disable_comment: payload.disableComment === true,
      brand_content_toggle: payload.brandContentToggle === true,
      brand_organic_toggle: payload.brandOrganicToggle === true,
      ...(typeof payload.aiGenerated === 'boolean' ? { is_aigc: payload.aiGenerated } : {}),
      ...(payload.coverTimestampMs != null ? { video_cover_timestamp_ms: payload.coverTimestampMs } : {}),
    },
    source_info: { source: 'PULL_FROM_URL', video_url: payload.videoUrl },
  };
  const res = await deps.fetch(`${API}/post/publish/video/init/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return httpFailure('TikTok init', res);
  const data = await readJson(res);
  if (data && data.error && data.error.code && data.error.code !== 'ok') {
    return fail(`TikTok init: ${data.error.code} ${data.error.message || ''}`.trim(), { kind: 'client' });
  }
  const publishId = data && data.data ? data.data.publish_id : null;
  return ok({
    externalId: publishId || null,
    url: null, // no public URL until upload + moderation complete; poll status
    status: privacy === 'SELF_ONLY' ? 'draft' : 'pending_review',
    requiresHumanFinalStep: privacy === 'SELF_ONLY',
  });
}

/**
 * Query the posting creator's options (must run before rendering the post page).
 * → ok({ creator: { nickname, username, avatarUrl, privacyLevelOptions, commentDisabled,
 *                   duetDisabled, stitchDisabled, maxVideoPostDurationSec } })
 */
async function fetchCreatorInfo(credentials, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('tiktok: accessToken is required', { kind: 'auth' });
  const res = await deps.fetch(`${API}/post/publish/creator_info/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return httpFailure('TikTok creator_info', res);
  const j = await readJson(res);
  const code = j && j.error && j.error.code;
  if (code && code !== 'ok') {
    const kind = code === 'access_token_invalid' || code === 'scope_not_authorized' ? 'auth' : 'client';
    return fail(`TikTok creator_info: ${code}`, { kind });
  }
  const d = (j && j.data) || {};
  return ok({
    creator: {
      nickname: d.creator_nickname || null,
      username: d.creator_username || null,
      avatarUrl: d.creator_avatar_url || null,
      privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
      commentDisabled: d.comment_disabled === true,
      duetDisabled: d.duet_disabled === true,
      stitchDisabled: d.stitch_disabled === true,
      maxVideoPostDurationSec: Number.isFinite(d.max_video_post_duration_sec) ? d.max_video_post_duration_sec : null,
    },
  });
}

// TikTok post ids are 19-digit integers in the JSON (above 2^53), so
// JSON.parse rounds them. Read them as digit strings from the raw text instead.
const POST_ID_LIST = /"(?:publicaly|publicly)_available_post_id"\s*:\s*\[([^\]]*)\]/;

function postIdsFromText(text) {
  const m = POST_ID_LIST.exec(text || '');
  return m ? m[1].match(/\d+/g) || [] : [];
}

/** Poll the publish status of a `publish_id` (post-init). `videoIds` are digit strings. */
async function fetchPublishStatus(credentials, publishId, depsIn) {
  const deps = resolveDeps(depsIn);
  const res = await deps.fetch(`${API}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${credentials.accessToken}` },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) return httpFailure('TikTok status', res);
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  const d = (j && j.data) || {};
  return ok({ status: d.status || null, failReason: d.fail_reason || null, videoIds: postIdsFromText(text), raw: j });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return { available: false, reason: 'accessToken is required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/video/query/?fields=id,like_count,comment_count,share_count,view_count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ filters: { video_ids: [externalId] } }),
  });
  if (res.status === 401 || res.status === 403) return { available: false, reason: 'video.list scope not granted', status: res.status };
  if (!res.ok) return { available: false, reason: (await httpFailure('TikTok video query', res)).error, status: res.status };
  const j = await readJson(res);
  const v = (j && j.data && j.data.videos && j.data.videos[0]) || null;
  if (!v) return { available: false, reason: 'video not found' };
  return { available: true, metrics: { impressions: null, views: v.view_count ?? null, likes: v.like_count ?? null, comments: v.comment_count ?? null, shares: v.share_count ?? null, saves: null, raw: j } };
}

module.exports = { platform: 'tiktok', capabilities: PLATFORMS.tiktok, validate, publish, fetchMetrics, fetchPublishStatus, fetchCreatorInfo };
