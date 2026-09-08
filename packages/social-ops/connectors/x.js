'use strict';

/**
 * X connector — v2 posts + v2 chunked media upload.
 *
 * credentials: { accessToken }             (OAuth 2.0 user context)
 * payload:     { text, threadParts?, mediaUrls?, mediaIds?, replyToId?, quoteId? }
 *
 * Thread semantics: `text` is the first post; each entry of `threadParts` is
 * posted as a reply to the previous one. Media (≤4 images or 1 video) attach
 * to the FIRST post only. Free-tier tokens are write-only, so fetchMetrics
 * returns `available: false` on 402/403 instead of failing the run.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://api.x.com/2';
const MEDIA_CHUNK = 4 * 1024 * 1024; // 4 MiB, under the 5 MiB APPEND cap

function validate(payload = {}) {
  const errors = [];
  const text = payload.text || '';
  if (!text.trim() && !(payload.mediaUrls && payload.mediaUrls.length) && !(payload.mediaIds && payload.mediaIds.length)) {
    errors.push('text or media is required');
  }
  if (text.length > PLATFORMS.x.text.maxLength) errors.push(`text exceeds ${PLATFORMS.x.text.maxLength} characters (${text.length})`);
  for (const [i, part] of (payload.threadParts || []).entries()) {
    if (String(part).length > PLATFORMS.x.text.maxLength) errors.push(`threadParts[${i}] exceeds ${PLATFORMS.x.text.maxLength} characters`);
  }
  if ((payload.mediaUrls || []).length > PLATFORMS.x.media.maxImages) errors.push(`at most ${PLATFORMS.x.media.maxImages} media per post`);
  return errors;
}

function mediaCategory(contentType) {
  if (/^video\//.test(contentType)) return 'tweet_video';
  if (contentType === 'image/gif') return 'tweet_gif';
  return 'tweet_image';
}

/** v2 media upload: INIT → APPEND(chunks) → FINALIZE (→ poll STATUS for video). */
async function uploadMedia(accessToken, url, deps) {
  const bin = await fetchBinary(url, deps);
  if (bin.error) return { error: bin.error };
  const auth = { Authorization: `Bearer ${accessToken}` };

  const init = new URLSearchParams({
    command: 'INIT',
    media_type: bin.contentType,
    total_bytes: String(bin.buffer.length),
    media_category: mediaCategory(bin.contentType),
  });
  const initRes = await deps.fetch(`${API}/media/upload`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: init.toString() });
  if (!initRes.ok) return { error: (await httpFailure('X media INIT', initRes)).error };
  const initJson = await readJson(initRes);
  const mediaId = (initJson && (initJson.data ? initJson.data.id : initJson.media_id_string || initJson.media_id)) || null;
  if (!mediaId) return { error: 'X media INIT returned no media id' };

  for (let offset = 0, segment = 0; offset < bin.buffer.length; offset += MEDIA_CHUNK, segment++) {
    const form = new FormData();
    form.set('command', 'APPEND');
    form.set('media_id', String(mediaId));
    form.set('segment_index', String(segment));
    form.set('media', new Blob([bin.buffer.subarray(offset, offset + MEDIA_CHUNK)], { type: bin.contentType }), 'chunk');
    const appendRes = await deps.fetch(`${API}/media/upload`, { method: 'POST', headers: auth, body: form });
    if (!appendRes.ok) return { error: (await httpFailure('X media APPEND', appendRes)).error };
  }

  const fin = new URLSearchParams({ command: 'FINALIZE', media_id: String(mediaId) });
  const finRes = await deps.fetch(`${API}/media/upload`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: fin.toString() });
  if (!finRes.ok) return { error: (await httpFailure('X media FINALIZE', finRes)).error };
  const finJson = await readJson(finRes);
  const processing = finJson && (finJson.data ? finJson.data.processing_info : finJson.processing_info);

  // Video is transcoded asynchronously; poll until succeeded (bounded).
  let waited = 0;
  let info = processing;
  while (info && info.state && info.state !== 'succeeded') {
    if (info.state === 'failed') return { error: 'X media processing failed' };
    const wait = Math.min((info.check_after_secs || 2) * 1000, 10_000);
    if (waited > 120_000) return { error: 'X media processing timed out' };
    await deps.sleep(wait);
    waited += wait;
    const st = await deps.fetch(`${API}/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, { headers: auth });
    if (!st.ok) return { error: (await httpFailure('X media STATUS', st)).error };
    const stJson = await readJson(st);
    info = stJson && (stJson.data ? stJson.data.processing_info : stJson.processing_info);
  }
  return { mediaId: String(mediaId) };
}

async function createPost(accessToken, body, deps) {
  const res = await deps.fetch(`${API}/tweets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return httpFailure('X API', res);
  const data = await readJson(res);
  const id = data && data.data ? data.data.id : null;
  return ok({ externalId: id, url: id ? `https://x.com/i/status/${id}` : null, raw: data });
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('x: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const mediaIds = [...(payload.mediaIds || [])];
  for (const url of payload.mediaUrls || []) {
    const up = await uploadMedia(accessToken, url, deps);
    if (up.error) return fail(up.error, { kind: 'client' });
    mediaIds.push(up.mediaId);
  }

  const first = { text: payload.text || '' };
  if (mediaIds.length) first.media = { media_ids: mediaIds };
  if (payload.replyToId) first.reply = { in_reply_to_tweet_id: String(payload.replyToId) };
  if (payload.quoteId) first.quote_tweet_id = String(payload.quoteId);

  const head = await createPost(accessToken, first, deps);
  if (!head.success) return head;

  const threadIds = [head.externalId];
  let parent = head.externalId;
  for (const part of payload.threadParts || []) {
    const r = await createPost(accessToken, { text: String(part), reply: { in_reply_to_tweet_id: String(parent) } }, deps);
    if (!r.success) {
      // The head is live; report partial success so the host does not re-post it.
      return ok({ externalId: head.externalId, url: head.url, status: 'published', partial: true, threadIds, error: `thread part failed: ${r.error}` });
    }
    threadIds.push(r.externalId);
    parent = r.externalId;
  }
  return ok({ externalId: head.externalId, url: head.url, status: 'published', threadIds });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return { available: false, reason: 'accessToken is required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/tweets/${encodeURIComponent(externalId)}?tweet.fields=public_metrics,non_public_metrics,organic_metrics`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 402 || res.status === 403 || res.status === 429) {
    return { available: false, reason: `read not permitted on this tier (${res.status})`, status: res.status };
  }
  if (!res.ok) return { available: false, reason: (await httpFailure('X metrics', res)).error, status: res.status };
  const data = await readJson(res);
  const m = (data && data.data && (data.data.public_metrics || {})) || {};
  const np = (data && data.data && (data.data.non_public_metrics || data.data.organic_metrics)) || {};
  return {
    available: true,
    metrics: {
      impressions: m.impression_count != null ? m.impression_count : (np.impression_count != null ? np.impression_count : null),
      views: m.impression_count != null ? m.impression_count : null,
      likes: m.like_count != null ? m.like_count : null,
      comments: m.reply_count != null ? m.reply_count : null,
      shares: (m.retweet_count || 0) + (m.quote_count || 0),
      saves: m.bookmark_count != null ? m.bookmark_count : null,
      raw: data,
    },
  };
}

module.exports = { platform: 'x', capabilities: PLATFORMS.x, validate, publish, fetchMetrics, _internals: { uploadMedia, createPost } };
