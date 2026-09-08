'use strict';

/**
 * TikTok connector — Content Posting API (Direct Post, PULL_FROM_URL).
 *
 * credentials: { accessToken }
 * payload:     { text (title/caption), videoUrl, privacyLevel?, disableComment?, disableDuet?, disableStitch?, coverTimestampMs? }
 *
 * Unaudited apps may only post `SELF_ONLY`: the video lands as a private draft
 * the account holder makes public in the app. That is the default here, so a
 * host that has NOT passed audit still gets a working (draft) flow, and one
 * that has passes `privacyLevel: 'PUBLIC_TO_EVERYONE'` explicitly. The
 * `video_url` domain must be verified in the developer portal.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps } = require('../result');

const API = 'https://open.tiktokapis.com/v2';
const PRIVACY = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('TikTok publishing requires a public video_url (MP4). Text-only posts are not supported.');
  if ((payload.text || '').length > PLATFORMS.tiktok.text.maxLength) errors.push(`caption exceeds ${PLATFORMS.tiktok.text.maxLength} characters`);
  if (payload.privacyLevel && !PRIVACY.has(payload.privacyLevel)) errors.push(`privacyLevel must be one of ${[...PRIVACY].join(', ')}`);
  return errors;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('tiktok: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const privacy = payload.privacyLevel || 'SELF_ONLY';
  const body = {
    post_info: {
      title: (payload.text || '').slice(0, PLATFORMS.tiktok.text.maxLength),
      privacy_level: privacy,
      disable_duet: payload.disableDuet === true,
      disable_stitch: payload.disableStitch === true,
      disable_comment: payload.disableComment === true,
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

/** Poll the publish status of a `publish_id` (post-init). */
async function fetchPublishStatus(credentials, publishId, depsIn) {
  const deps = resolveDeps(depsIn);
  const res = await deps.fetch(`${API}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${credentials.accessToken}` },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) return httpFailure('TikTok status', res);
  const j = await readJson(res);
  const d = (j && j.data) || {};
  return ok({ status: d.status || null, failReason: d.fail_reason || null, videoIds: d.publicaly_available_post_id || d.publicly_available_post_id || [], raw: j });
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

module.exports = { platform: 'tiktok', capabilities: PLATFORMS.tiktok, validate, publish, fetchMetrics, fetchPublishStatus };
