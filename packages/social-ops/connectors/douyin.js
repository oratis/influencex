'use strict';

/**
 * 抖音 connector — 开放平台 视频发布 (upload_video → create_video).
 *
 * credentials: { accessToken, openId }
 * payload:     { text (标题/文案), videoUrl, coverTsp?, poiId?, microAppId? }
 *
 * ⚠️ endpointsVerified: false — request shapes follow the published 抖音开放平台
 * docs (api/douyin/v1/video/*) and have NOT been exercised against a live,
 * audited app by this repo. video.create is granted per app after review; a
 * 企业号 is required for most brand accounts. Verify before issuing keys.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://open.douyin.com/api/douyin/v1/video';

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('抖音 publishing requires a public video_url');
  if ((payload.text || '').length > PLATFORMS.douyin.text.maxLength) errors.push(`text exceeds ${PLATFORMS.douyin.text.maxLength} characters`);
  return errors;
}

function dyError(label, j) {
  const d = j && j.data;
  if (d && typeof d.error_code === 'number' && d.error_code !== 0) {
    const auth = d.error_code === 2190002 || d.error_code === 2190008; // token invalid / expired
    return fail(`${label} ${d.error_code}: ${d.description || ''}`, { kind: auth ? 'auth' : 'client', errcode: d.error_code });
  }
  return null;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.openId) return fail('douyin: accessToken + openId are required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const bin = await fetchBinary(payload.videoUrl, deps);
  if (bin.error) return fail(bin.error, { kind: 'client' });
  const form = new FormData();
  form.set('video', new Blob([bin.buffer], { type: bin.contentType }), 'video.mp4');
  const upRes = await deps.fetch(`${API}/upload_video/?open_id=${encodeURIComponent(creds.openId)}`, {
    method: 'POST',
    headers: { 'access-token': creds.accessToken },
    body: form,
  });
  if (!upRes.ok) return httpFailure('抖音 upload_video', upRes);
  const up = await readJson(upRes);
  const upErr = dyError('抖音 upload_video', up);
  if (upErr) return upErr;
  const videoId = up && up.data && up.data.video && up.data.video.video_id;
  if (!videoId) return fail('抖音 upload_video returned no video_id');

  const body = { video_id: videoId, text: payload.text || '' };
  if (payload.poiId) body.poi_id = payload.poiId;
  if (payload.microAppId) body.micro_app_id = payload.microAppId;
  if (payload.coverTsp != null) body.cover_tsp = payload.coverTsp;
  const crRes = await deps.fetch(`${API}/create_video/?open_id=${encodeURIComponent(creds.openId)}`, {
    method: 'POST',
    headers: { 'access-token': creds.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!crRes.ok) return httpFailure('抖音 create_video', crRes);
  const cr = await readJson(crRes);
  const crErr = dyError('抖音 create_video', cr);
  if (crErr) return crErr;
  const itemId = cr && cr.data && cr.data.item_id;
  return ok({ externalId: itemId || null, url: null, status: 'pending_review', requiresHumanFinalStep: false, note: '抖音 reviews every upload before it is visible' });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.openId) return { available: false, reason: 'accessToken + openId are required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/video_data/?open_id=${encodeURIComponent(creds.openId)}`, {
    method: 'POST',
    headers: { 'access-token': creds.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_ids: [externalId] }),
  });
  if (!res.ok) return { available: false, reason: (await httpFailure('抖音 video_data', res)).error, status: res.status };
  const j = await readJson(res);
  const err = dyError('抖音 video_data', j);
  if (err) return { available: false, reason: err.error };
  const v = (j && j.data && j.data.list && j.data.list[0]) || null;
  if (!v) return { available: false, reason: 'video not found' };
  const s = v.statistics || {};
  return { available: true, metrics: { impressions: null, views: s.play_count ?? null, likes: s.digg_count ?? null, comments: s.comment_count ?? null, shares: s.share_count ?? null, saves: null, raw: j } };
}

module.exports = { platform: 'douyin', capabilities: PLATFORMS.douyin, validate, publish, fetchMetrics };
