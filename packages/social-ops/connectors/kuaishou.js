'use strict';

/**
 * 快手 connector — 开放平台 视频发布 (start_upload → upload → publish).
 *
 * credentials: { accessToken, appId }
 * payload:     { text (caption), videoUrl, coverUrl? }
 *
 * ⚠️ endpointsVerified: false — follows the published 快手开放平台 flow
 * (openapi/photo/start_upload → <endpoint>/api/upload → openapi/photo/publish)
 * and has NOT been exercised against a live, audited app by this repo.
 * user_video_publish is granted per app after review.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://open.kuaishou.com/openapi/photo';

function validate(payload = {}) {
  const errors = [];
  if (!payload.videoUrl) errors.push('快手 publishing requires a public video_url');
  if ((payload.text || '').length > PLATFORMS.kuaishou.text.maxLength) errors.push(`caption exceeds ${PLATFORMS.kuaishou.text.maxLength} characters`);
  return errors;
}

function ksError(label, j) {
  if (j && j.result != null && j.result !== 1) {
    return fail(`${label} ${j.result}: ${j.error_msg || ''}`, { kind: j.result === 100200100 || j.result === 100200101 ? 'auth' : 'client', errcode: j.result });
  }
  return null;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.appId) return fail('kuaishou: accessToken + appId are required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const q = `app_id=${encodeURIComponent(creds.appId)}&access_token=${encodeURIComponent(creds.accessToken)}`;
  const stRes = await deps.fetch(`${API}/start_upload?${q}`, { method: 'POST' });
  if (!stRes.ok) return httpFailure('快手 start_upload', stRes);
  const st = await readJson(stRes);
  const stErr = ksError('快手 start_upload', st);
  if (stErr) return stErr;
  const uploadToken = st && st.upload_token;
  const endpoint = st && st.endpoint;
  if (!uploadToken || !endpoint) return fail('快手 start_upload returned no upload_token/endpoint');

  const bin = await fetchBinary(payload.videoUrl, deps);
  if (bin.error) return fail(bin.error, { kind: 'client' });
  const upRes = await deps.fetch(`https://${endpoint}/api/upload?upload_token=${encodeURIComponent(uploadToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: bin.buffer,
  });
  if (!upRes.ok) return httpFailure('快手 upload', upRes);
  const up = await readJson(upRes);
  if (up && up.result != null && up.result !== 1) return fail(`快手 upload ${up.result}: ${up.message || ''}`);

  const form = new FormData();
  form.set('caption', payload.text || '');
  if (payload.coverUrl) {
    const cover = await fetchBinary(payload.coverUrl, deps);
    if (!cover.error) form.set('cover', new Blob([cover.buffer], { type: cover.contentType }), 'cover.jpg');
  }
  const pubRes = await deps.fetch(`${API}/publish?${q}&upload_token=${encodeURIComponent(uploadToken)}`, { method: 'POST', body: form });
  if (!pubRes.ok) return httpFailure('快手 publish', pubRes);
  const pub = await readJson(pubRes);
  const pubErr = ksError('快手 publish', pub);
  if (pubErr) return pubErr;
  const info = (pub && pub.video_info) || {};
  return ok({ externalId: info.photo_id || null, url: null, status: 'pending_review', note: '快手 reviews every upload before it is visible' });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.appId) return { available: false, reason: 'accessToken + appId are required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/list?app_id=${encodeURIComponent(creds.appId)}&access_token=${encodeURIComponent(creds.accessToken)}&count=50`);
  if (!res.ok) return { available: false, reason: (await httpFailure('快手 photo/list', res)).error, status: res.status };
  const j = await readJson(res);
  const err = ksError('快手 photo/list', j);
  if (err) return { available: false, reason: err.error };
  const v = ((j && j.video_list) || []).find((x) => x.photo_id === externalId) || null;
  if (!v) return { available: false, reason: 'video not in the latest page' };
  return { available: true, metrics: { impressions: null, views: v.view_count ?? null, likes: v.like_count ?? null, comments: v.comment_count ?? null, shares: null, saves: null, raw: v } };
}

module.exports = { platform: 'kuaishou', capabilities: PLATFORMS.kuaishou, validate, publish, fetchMetrics };
