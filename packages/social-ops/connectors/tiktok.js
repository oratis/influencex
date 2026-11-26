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
 * `brandContentToggle` is TikTok's "Branded content" checkbox (promotes a third
 * party; the post is labelled "Paid partnership") and `brandOrganicToggle` is
 * "Your brand" (promotes the poster's own business). Both are always sent as
 * booleans, default false. Branded content can only be public or friends-only,
 * so `brandContentToggle` with any other privacy level is rejected by validate().
 *
 * Failures never carry upstream text: `error` is `TikTok <label> <http status>:
 * <code>` where <code> is a documented TikTok error code or `unrecognized_error`.
 * `kind` is `auth` (token must be re-issued), `policy` (account or app is
 * blocked by TikTok rules; not an auth problem, never retry), `rate_limit` /
 * `server` (retryable) or `client`.
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
// Content Sharing Guidelines: branded content "can only be configured with visibility as public/friends".
const BRANDED_PRIVACY = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS']);

// Documented error.code values (Direct Post, Query Creator Info) -> failure kind.
// Only these may appear in `error`; anything else is reported as unrecognized_error.
// `policy` codes arrive as HTTP 403 but are not credential problems, so a host
// must not mark the account needs_reauth for them.
const ERROR_KIND = Object.freeze({
  invalid_param: 'client',
  access_token_invalid: 'auth',
  scope_not_authorized: 'auth',
  rate_limit_exceeded: 'rate_limit',
  spam_risk_too_many_posts: 'policy',
  spam_risk_user_banned_from_posting: 'policy',
  reached_active_user_cap: 'policy',
  unaudited_client_can_only_post_to_private_accounts: 'policy',
  url_ownership_unverified: 'policy',
  privacy_level_option_mismatch: 'policy',
});
const RETRYABLE_KINDS = new Set(['rate_limit', 'server']);

function kindOf(status, code) {
  if (status >= 500) return 'server';
  if (status === 401) return 'auth';
  if (Object.hasOwn(ERROR_KIND, code)) return ERROR_KIND[code];
  return status === 429 ? 'rate_limit' : 'client';
}

/** error.code of a parsed TikTok body, or undefined when there is none. */
function errorCodeOf(json) {
  const e = json && typeof json === 'object' ? json.error : null;
  return e && typeof e === 'object' && e.code != null && e.code !== '' ? e.code : undefined;
}

/**
 * The one failure builder for TikTok responses (non-2xx, or 200 with an error
 * code). Never copies error.message or body text into `error`.
 */
function tiktokFailure(label, status, json) {
  const code = errorCodeOf(json);
  const known = typeof code === 'string' && Object.hasOwn(ERROR_KIND, code);
  const kind = kindOf(status, known ? code : undefined);
  return fail(`TikTok ${label} ${status}: ${known ? code : 'unrecognized_error'}`, {
    status,
    kind,
    retryable: RETRYABLE_KINDS.has(kind),
  });
}

/** Read the body as JSON (after an optional text rewrite); null when it is not valid JSON. */
async function readJsonBody(res, prepare = (t) => t) {
  try {
    return JSON.parse(prepare(await res.text()));
  } catch {
    return null;
  }
}

const unreadable = (label) => fail(`TikTok ${label}: unreadable response`, { kind: 'server', retryable: true });

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('TikTok publishing requires a public video_url (MP4). Text-only posts are not supported.');
  if ((payload.text || '').length > PLATFORMS.tiktok.text.maxLength) errors.push(`caption exceeds ${PLATFORMS.tiktok.text.maxLength} characters`);
  if (payload.privacyLevel && !PRIVACY.has(payload.privacyLevel)) errors.push(`privacyLevel must be one of ${[...PRIVACY].join(', ')}`);
  if (payload.brandContentToggle === true && !BRANDED_PRIVACY.has(payload.privacyLevel || DEFAULT_PRIVACY)) errors.push('branded content must be public or friends-only');
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
  const data = await readJsonBody(res);
  if (!res.ok || (errorCodeOf(data) !== undefined && errorCodeOf(data) !== 'ok')) return tiktokFailure('init', res.status, data);
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
  const j = await readJsonBody(res);
  const code = errorCodeOf(j);
  if (!res.ok || (code !== undefined && code !== 'ok')) return tiktokFailure('creator_info', res.status, j);
  const d = j && j.data;
  const usable = code === 'ok' && d && typeof d === 'object' && !Array.isArray(d)
    && Array.isArray(d.privacy_level_options) && d.privacy_level_options.every((o) => typeof o === 'string')
    && typeof d.comment_disabled === 'boolean' && typeof d.duet_disabled === 'boolean' && typeof d.stitch_disabled === 'boolean';
  if (!usable) return unreadable('creator_info');
  return ok({
    creator: {
      nickname: d.creator_nickname || null,
      username: d.creator_username || null,
      avatarUrl: d.creator_avatar_url || null,
      privacyLevelOptions: d.privacy_level_options,
      commentDisabled: d.comment_disabled,
      duetDisabled: d.duet_disabled,
      stitchDisabled: d.stitch_disabled,
      maxVideoPostDurationSec: Number.isFinite(d.max_video_post_duration_sec) && d.max_video_post_duration_sec > 0 ? d.max_video_post_duration_sec : null,
    },
  });
}

// TikTok post ids are 19-digit integers in the JSON (above 2^53), so JSON.parse
// rounds them. Node 20 has no JSON.parse source access, so quote every integer
// token of 16+ digits outside string literals before parsing; ids then arrive
// as exact strings. Anything that is not valid JSON still fails JSON.parse.
const INT_TOKEN = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

function quoteLongIntegers(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      INT_TOKEN.lastIndex = i;
      const m = INT_TOKEN.exec(text);
      const tok = m ? m[0] : ch;
      const isInt = m && m[1] === undefined && m[2] === undefined;
      out += isInt && tok.replace('-', '').length >= 16 ? `"${tok}"` : tok;
      i += tok.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Post ids from `data.publicaly_available_post_id` / `data.publicly_available_post_id` only; digit strings. */
function postIdsFrom(json) {
  const d = json && json.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  const list = [d.publicaly_available_post_id, d.publicly_available_post_id].find(Array.isArray) || [];
  return list.flatMap((v) => {
    if (typeof v === 'string' && /^\d+$/.test(v)) return [v];
    if (Number.isSafeInteger(v) && v > 0) return [String(v)];
    return [];
  });
}

/** Poll the publish status of a `publish_id` (post-init). `videoIds` are digit strings. */
async function fetchPublishStatus(credentials, publishId, depsIn) {
  const deps = resolveDeps(depsIn);
  const res = await deps.fetch(`${API}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${credentials.accessToken}` },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const j = await readJsonBody(res, quoteLongIntegers);
  const code = errorCodeOf(j);
  if (!res.ok || (code !== undefined && code !== 'ok')) return tiktokFailure('status', res.status, j);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return unreadable('status');
  const d = j.data && typeof j.data === 'object' ? j.data : {};
  return ok({ status: d.status || null, failReason: d.fail_reason || null, videoIds: postIdsFrom(j), raw: j });
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
