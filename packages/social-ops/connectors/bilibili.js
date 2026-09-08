'use strict';

/**
 * 哔哩哔哩 connector — 开放平台 视频稿件投稿 (arcopen).
 *
 * credentials: { accessToken, clientId, clientSecret }
 * payload:     { title, text (desc), videoUrl, coverUrl, tags[], tid?, copyright? (1 自制 / 2 转载), noReprint? }
 *
 * ⚠️ endpointsVerified: false — follows the published 开放平台 flow
 * (archive/video/init → upload → complete → cover/upload → add-by-utoken)
 * with the documented HMAC-SHA256 header signature, and has NOT been
 * exercised against a live approved application by this repo.
 */

const crypto = require('crypto');
const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://member.bilibili.com/arcopen/fn';

function validate(payload = {}) {
  const errors = [];
  const t = PLATFORMS.bilibili.text;
  if (!payload.title) errors.push('title is required');
  if ((payload.title || '').length > t.titleMaxLength) errors.push(`title exceeds ${t.titleMaxLength} characters`);
  if ((payload.text || '').length > t.maxLength) errors.push(`desc exceeds ${t.maxLength} characters`);
  if (!payload.videoUrl) errors.push('B站 publishing requires a public video_url');
  if (!payload.coverUrl) errors.push('coverUrl is required (稿件必须有封面)');
  const tags = payload.tags || [];
  if (!tags.length) errors.push('at least one tag is required');
  if (tags.length > t.maxTags) errors.push(`at most ${t.maxTags} tags`);
  for (const tag of tags) if (String(tag).length > t.tagMaxLength) errors.push(`tag "${tag}" exceeds ${t.tagMaxLength} characters`);
  return errors;
}

/**
 * 开放平台 request signature: sorted x-bili-* headers joined as "k:v\n",
 * HMAC-SHA256 with the app secret, hex → Authorization.
 */
function signedHeaders({ accessToken, clientId, clientSecret }, contentMd5 = '') {
  const h = {
    'x-bili-accesskeyid': clientId,
    'x-bili-content-md5': contentMd5,
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': crypto.randomUUID(),
    'x-bili-signature-version': '2.0',
    'x-bili-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const canonical = Object.keys(h).sort().map((k) => `${k}:${h[k]}`).join('\n');
  const signature = crypto.createHmac('sha256', clientSecret).update(canonical).digest('hex');
  return { ...h, Authorization: signature, 'Access-Token': accessToken };
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function biliError(label, j) {
  if (j && typeof j.code === 'number' && j.code !== 0) {
    return fail(`${label} ${j.code}: ${j.message || ''}`, { kind: j.code === 401 || j.code === 403 ? 'auth' : 'client', errcode: j.code });
  }
  return null;
}

async function signedJson(creds, path, body, deps) {
  const raw = body ? JSON.stringify(body) : '';
  const res = await deps.fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signedHeaders(creds, raw ? md5(raw) : '') },
    body: raw || undefined,
  });
  if (!res.ok) return { failure: await httpFailure(`B站 ${path}`, res) };
  const j = await readJson(res);
  const err = biliError(`B站 ${path}`, j);
  if (err) return { failure: err };
  return { data: (j && j.data) || {} };
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.clientId || !creds.clientSecret) return fail('bilibili: accessToken + clientId + clientSecret are required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const bin = await fetchBinary(payload.videoUrl, deps);
  if (bin.error) return fail(bin.error, { kind: 'client' });

  // 1. init upload (utype=0 → single-part upload for small files)
  const init = await signedJson(creds, `/archive/video/init?name=${encodeURIComponent('video.mp4')}&utype=0`, null, deps);
  if (init.failure) return init.failure;
  const uploadToken = init.data.upload_token;
  if (!uploadToken) return fail('B站 video/init returned no upload_token');

  // 2. upload bytes
  const form = new FormData();
  form.set('file', new Blob([bin.buffer], { type: bin.contentType }), 'video.mp4');
  const upRes = await deps.fetch(`${API}/archive/video/upload?upload_token=${encodeURIComponent(uploadToken)}`, { method: 'POST', headers: signedHeaders(creds), body: form });
  if (!upRes.ok) return httpFailure('B站 video/upload', upRes);
  const upErr = biliError('B站 video/upload', await readJson(upRes));
  if (upErr) return upErr;

  // 3. complete
  const done = await signedJson(creds, `/archive/video/complete?upload_token=${encodeURIComponent(uploadToken)}`, null, deps);
  if (done.failure) return done.failure;

  // 4. cover
  const cover = await fetchBinary(payload.coverUrl, deps);
  if (cover.error) return fail(cover.error, { kind: 'client' });
  const cform = new FormData();
  cform.set('file', new Blob([cover.buffer], { type: cover.contentType }), 'cover.jpg');
  const cvRes = await deps.fetch(`${API}/archive/cover/upload`, { method: 'POST', headers: signedHeaders(creds), body: cform });
  if (!cvRes.ok) return httpFailure('B站 cover/upload', cvRes);
  const cv = await readJson(cvRes);
  const cvErr = biliError('B站 cover/upload', cv);
  if (cvErr) return cvErr;
  const coverUrl = cv && cv.data && cv.data.url;

  // 5. submit the archive
  const archive = {
    title: payload.title,
    cover: coverUrl,
    tid: payload.tid || 168, // 168 = 国创相关 as a neutral default; hosts pass the real 分区
    no_reprint: payload.noReprint === false ? 0 : 1,
    desc: payload.text || '',
    tag: (payload.tags || []).join(','),
    copyright: payload.copyright || 1,
  };
  const add = await signedJson(creds, `/archive/add-by-utoken?upload_token=${encodeURIComponent(uploadToken)}`, archive, deps);
  if (add.failure) return add.failure;
  const resourceId = add.data.resource_id || null;
  return ok({ externalId: resourceId, url: null, status: 'pending_review', note: 'B站 稿件审核 before it is visible; url appears as https://www.bilibili.com/video/<bvid> after review' });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.accessToken || !creds.clientId || !creds.clientSecret) return { available: false, reason: 'accessToken + clientId + clientSecret are required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const r = await signedJson(creds, `/archive/view?resource_id=${encodeURIComponent(externalId)}`, null, deps);
  if (r.failure) return { available: false, reason: r.failure.error };
  const s = r.data.stat || {};
  return { available: true, metrics: { impressions: null, views: s.view ?? null, likes: s.like ?? null, comments: s.reply ?? null, shares: s.share ?? null, saves: s.favorite ?? null, raw: r.data } };
}

module.exports = { platform: 'bilibili', capabilities: PLATFORMS.bilibili, validate, publish, fetchMetrics, _internals: { signedHeaders } };
