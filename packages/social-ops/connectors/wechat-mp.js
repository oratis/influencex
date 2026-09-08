'use strict';

/**
 * 微信公众号 connector — draft box first, freepublish as a separate, explicit
 * step (api_draft mode).
 *
 * credentials: { appId, appSecret } | { accessToken }   (host may cache the token)
 * payload:     { title, text (inline-styled HTML body), digest?, author?, coverUrl | thumbMediaId, contentSourceUrl?, bodyImageUrls?, needOpenComment?, onlyFansCanComment? }
 *
 * Flow: token → upload cover as permanent material (thumb_media_id) → upload
 * body images through media/uploadimg and rewrite their src → draft/add.
 * `publish()` STOPS at the draft: `submitPublish()` is the irreversible step
 * and is called on purpose by the host after human approval.
 *
 * The AppSecret is a server credential and the caller's egress IP must be on
 * the 公众号 API allowlist; 40164 means it is not. 48001 usually means a
 * 小程序 AppID was supplied, or the account is not 认证.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://api.weixin.qq.com/cgi-bin';

function validate(payload = {}) {
  const errors = [];
  const t = PLATFORMS.wechat_mp.text;
  if (!payload.title) errors.push('title is required');
  if ((payload.title || '').length > t.titleMaxLength) errors.push(`title exceeds ${t.titleMaxLength} characters`);
  if (!payload.text) errors.push('text (HTML body) is required');
  if ((payload.text || '').length > t.maxLength) errors.push(`body exceeds ${t.maxLength} characters`);
  if ((payload.digest || '').length > t.digestMaxLength) errors.push(`digest exceeds ${t.digestMaxLength} characters`);
  if ((payload.author || '').length > t.authorMaxLength) errors.push(`author exceeds ${t.authorMaxLength} characters`);
  if (!payload.coverUrl && !payload.thumbMediaId) errors.push('coverUrl or thumbMediaId is required (公众号 articles need a cover)');
  if (/<style[\s>]/i.test(payload.text || '')) errors.push('body must be inline-styled: the editor drops <style> tags');
  return errors;
}

function wxError(label, j) {
  if (j && typeof j.errcode === 'number' && j.errcode !== 0) {
    const hint = j.errcode === 40164 ? ' (caller IP not on the API allowlist)'
      : j.errcode === 48001 ? ' (api unauthorized: 小程序 AppID or account not 认证)'
      : j.errcode === 40001 || j.errcode === 42001 ? ' (token invalid/expired)' : '';
    return fail(`${label} ${j.errcode}: ${j.errmsg || ''}${hint}`, { kind: j.errcode === 45009 ? 'rate_limit' : (j.errcode === 40001 || j.errcode === 42001 ? 'auth' : 'client'), retryable: j.errcode === 45009 || j.errcode === -1, errcode: j.errcode });
  }
  return null;
}

async function getAccessToken(credentials, depsIn) {
  const deps = resolveDeps(depsIn);
  if (credentials && credentials.accessToken) return ok({ accessToken: credentials.accessToken, cached: true });
  if (!credentials || !credentials.appId || !credentials.appSecret) return fail('wechat_mp: appId + appSecret (or accessToken) required', { kind: 'auth' });
  const res = await deps.fetch(`${API}/token?grant_type=client_credential&appid=${encodeURIComponent(credentials.appId)}&secret=${encodeURIComponent(credentials.appSecret)}`);
  if (!res.ok) return httpFailure('WeChat token', res);
  const j = await readJson(res);
  const err = wxError('WeChat token', j);
  if (err) return err;
  if (!j || !j.access_token) return fail('WeChat token: no access_token in response');
  return ok({ accessToken: j.access_token, expiresIn: j.expires_in || 7200, cached: false });
}

async function uploadMaterial(accessToken, url, type, deps) {
  const bin = await fetchBinary(url, deps);
  if (bin.error) return { error: bin.error };
  const form = new FormData();
  const ext = (bin.contentType.split('/')[1] || 'jpg').split(';')[0];
  form.set('media', new Blob([bin.buffer], { type: bin.contentType }), `cover.${ext}`);
  const endpoint = type === 'body_image'
    ? `${API}/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`
    : `${API}/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`;
  const res = await deps.fetch(endpoint, { method: 'POST', body: form });
  if (!res.ok) return { error: (await httpFailure('WeChat upload', res)).error };
  const j = await readJson(res);
  const err = wxError('WeChat upload', j);
  if (err) return { error: err.error };
  return { mediaId: j.media_id || null, url: j.url || null };
}

/** Create the draft. Returns the draft media_id; nothing is public yet. */
async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });
  const tok = await getAccessToken(credentials, deps);
  if (!tok.success) return tok;
  const accessToken = tok.accessToken;

  let thumbMediaId = payload.thumbMediaId || null;
  if (!thumbMediaId) {
    const up = await uploadMaterial(accessToken, payload.coverUrl, 'cover', deps);
    if (up.error) return fail(up.error, { kind: 'client' });
    thumbMediaId = up.mediaId;
  }

  // Body images must be mmbiz URLs; external <img src> is dropped by the editor.
  let html = payload.text;
  for (const src of payload.bodyImageUrls || []) {
    const up = await uploadMaterial(accessToken, src, 'body_image', deps);
    if (up.error) return fail(`body image upload failed: ${up.error}`, { kind: 'client' });
    if (up.url) html = html.split(src).join(up.url);
  }

  const article = {
    title: payload.title,
    author: payload.author || '',
    digest: payload.digest || '',
    content: html,
    content_source_url: payload.contentSourceUrl || '',
    thumb_media_id: thumbMediaId,
    need_open_comment: payload.needOpenComment === false ? 0 : 1,
    only_fans_can_comment: payload.onlyFansCanComment === true ? 1 : 0,
  };
  const res = await deps.fetch(`${API}/draft/add?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ articles: [article] }),
  });
  if (!res.ok) return httpFailure('WeChat draft/add', res);
  const j = await readJson(res);
  const err = wxError('WeChat draft/add', j);
  if (err) return err;
  return ok({ externalId: (j && j.media_id) || null, url: null, status: 'draft', requiresHumanFinalStep: true, thumbMediaId, accessToken: tok.cached ? undefined : accessToken });
}

/** The irreversible step: submit a draft for 群发/发布. */
async function submitPublish(credentials, draftMediaId, depsIn) {
  const deps = resolveDeps(depsIn);
  if (!draftMediaId) return fail('draftMediaId is required', { kind: 'client' });
  const tok = await getAccessToken(credentials, deps);
  if (!tok.success) return tok;
  const res = await deps.fetch(`${API}/freepublish/submit?access_token=${encodeURIComponent(tok.accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ media_id: draftMediaId }),
  });
  if (!res.ok) return httpFailure('WeChat freepublish/submit', res);
  const j = await readJson(res);
  const err = wxError('WeChat freepublish/submit', j);
  if (err) return err;
  return ok({ externalId: (j && j.publish_id) || null, status: 'pending_review' });
}

/** Poll freepublish status; article_id + url appear when publish_status === 0. */
async function fetchPublishStatus(credentials, publishId, depsIn) {
  const deps = resolveDeps(depsIn);
  const tok = await getAccessToken(credentials, deps);
  if (!tok.success) return tok;
  const res = await deps.fetch(`${API}/freepublish/get?access_token=${encodeURIComponent(tok.accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) return httpFailure('WeChat freepublish/get', res);
  const j = await readJson(res);
  const err = wxError('WeChat freepublish/get', j);
  if (err) return err;
  const item = j && j.article_detail && j.article_detail.item && j.article_detail.item[0];
  const status = j.publish_status; // 0 成功 1 发布中 2 原创失败 3 常规失败 4 平台审核不通过 5 成功后用户删除 6 成功后系统封禁
  return ok({ publishStatus: status, articleId: (j && j.article_id) || null, url: (item && item.article_url) || null, status: status === 0 ? 'published' : (status === 1 ? 'pending_review' : 'failed'), raw: j });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  // 公众号 exposes article stats through datacube/getarticletotal by date, not
  // by article id in one call; hosts pull the daily report instead. Report
  // honestly rather than fake a per-post number.
  return { available: false, reason: 'use datacube/getarticletotal (date-ranged) from the host; no per-article endpoint' , externalId };
}

module.exports = { platform: 'wechat_mp', capabilities: PLATFORMS.wechat_mp, validate, getAccessToken, publish, submitPublish, fetchPublishStatus, fetchMetrics };
