'use strict';

/**
 * YouTube connector — Data API v3 resumable upload (Shorts are ordinary
 * vertical uploads ≤ 3 min; the platform classifies them).
 *
 * credentials: { accessToken }
 * payload:     { title, text (description), videoUrl, tags?, privacyStatus?, categoryId?, publishAt?, madeForKids? }
 *
 * Privacy defaults to `private` so a human can verify before the video is
 * public; hosts opt into 'public' explicitly. `publishAt` (ISO) uses the
 * platform's own scheduler — when set, privacyStatus is forced to private as
 * the API requires.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const API = 'https://www.googleapis.com/youtube/v3';

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('YouTube publishing requires a public video_url (direct MP4 / WebM). Text-only posts are not supported.');
  const title = payload.title || '';
  if (title.length > PLATFORMS.youtube.text.titleMaxLength) errors.push(`title exceeds ${PLATFORMS.youtube.text.titleMaxLength} characters`);
  if (/[<>]/.test(title)) errors.push('title may not contain < or >');
  const desc = payload.text || '';
  if (desc.length > PLATFORMS.youtube.text.maxLength) errors.push(`description exceeds ${PLATFORMS.youtube.text.maxLength} characters`);
  const tagsLen = (payload.tags || []).join(',').length;
  if (tagsLen > PLATFORMS.youtube.text.tagsTotalMaxLength) errors.push(`tags exceed ${PLATFORMS.youtube.text.tagsTotalMaxLength} characters in total`);
  return errors;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('youtube: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const bin = await fetchBinary(payload.videoUrl, deps);
  if (bin.error) return fail(`Failed to fetch video_url (${bin.status})`, { kind: 'client' });

  const scheduled = !!payload.publishAt;
  const metadata = {
    snippet: {
      title: (payload.title || (payload.text || '').split('\n')[0] || 'Untitled').slice(0, PLATFORMS.youtube.text.titleMaxLength),
      description: payload.text || '',
      tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 15) : undefined,
      categoryId: payload.categoryId || '22',
    },
    status: {
      privacyStatus: scheduled ? 'private' : (payload.privacyStatus || 'private'),
      selfDeclaredMadeForKids: payload.madeForKids === true,
      ...(scheduled ? { publishAt: payload.publishAt } : {}),
    },
  };

  const initRes = await deps.fetch(UPLOAD, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': bin.contentType,
      'X-Upload-Content-Length': String(bin.buffer.length),
    },
    body: JSON.stringify(metadata),
  });
  if (!initRes.ok) return httpFailure('YouTube init', initRes);
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) return fail('YouTube did not return an upload Location header');

  const uploadRes = await deps.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': bin.contentType, 'Content-Length': String(bin.buffer.length) },
    body: bin.buffer,
  });
  if (!uploadRes.ok) return httpFailure('YouTube upload', uploadRes);
  const data = (await readJson(uploadRes)) || {};
  const videoId = data.id || null;
  return ok({
    externalId: videoId,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    status: metadata.status.privacyStatus === 'public' ? 'published' : (scheduled ? 'scheduled' : 'draft'),
    privacyStatus: metadata.status.privacyStatus,
    quotaUnits: PLATFORMS.youtube.limits.quotaUnitsPerUpload,
  });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return { available: false, reason: 'accessToken is required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/videos?part=statistics&id=${encodeURIComponent(externalId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { available: false, reason: (await httpFailure('YouTube statistics', res)).error, status: res.status };
  const j = await readJson(res);
  const s = (j && j.items && j.items[0] && j.items[0].statistics) || null;
  if (!s) return { available: false, reason: 'video not found' };
  const n = (v) => (v == null ? null : Number(v));
  return {
    available: true,
    metrics: { impressions: null, views: n(s.viewCount), likes: n(s.likeCount), comments: n(s.commentCount), shares: null, saves: n(s.favoriteCount), raw: j },
    quotaUnits: 1,
  };
}

module.exports = { platform: 'youtube', capabilities: PLATFORMS.youtube, validate, publish, fetchMetrics };
