'use strict';

/**
 * Instagram connector — Content Publishing API (Graph), image posts and Reels.
 *
 * credentials: { accessToken, igUserId }   (Page token + IG professional user id)
 * payload:     { text (caption), imageUrl? | videoUrl?, coverUrl?, shareToFeed? }
 *
 * Two-step container → publish. Reels containers transcode asynchronously, so
 * the connector polls the container status (bounded) before publishing.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps } = require('../result');

const GRAPH = 'https://graph.facebook.com/v21.0';

function validate(payload = {}) {
  const errors = [];
  if (!payload.imageUrl && !payload.videoUrl) errors.push('Instagram requires a public image_url or video_url — text-only posts are not supported');
  const caption = payload.text || '';
  if (caption.length > PLATFORMS.instagram.text.maxLength) errors.push(`caption exceeds ${PLATFORMS.instagram.text.maxLength} characters`);
  const tags = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags > PLATFORMS.instagram.text.maxHashtags) errors.push(`more than ${PLATFORMS.instagram.text.maxHashtags} hashtags`);
  return errors;
}

async function waitForContainer(accessToken, creationId, deps) {
  let waited = 0;
  while (waited < 180_000) {
    const res = await deps.fetch(`${GRAPH}/${encodeURIComponent(creationId)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`);
    if (!res.ok) return { error: (await httpFailure('Instagram container status', res)).error };
    const j = await readJson(res);
    const code = j && j.status_code;
    if (code === 'FINISHED') return { ready: true };
    if (code === 'ERROR' || code === 'EXPIRED') return { error: `Instagram container ${code}: ${(j && j.status) || ''}` };
    await deps.sleep(5000);
    waited += 5000;
  }
  return { error: 'Instagram container did not finish processing in time' };
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  const igUserId = credentials && credentials.igUserId;
  if (!igUserId) return fail('Instagram connection missing ig_user_id (reconnect account)', { kind: 'auth' });
  if (!accessToken) return fail('instagram: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const createParams = new URLSearchParams({ caption: payload.text || '', access_token: accessToken });
  const isVideo = !!payload.videoUrl;
  if (isVideo) {
    createParams.set('media_type', 'REELS');
    createParams.set('video_url', payload.videoUrl);
    if (payload.coverUrl) createParams.set('cover_url', payload.coverUrl);
    if (payload.shareToFeed === false) createParams.set('share_to_feed', 'false');
  } else {
    createParams.set('image_url', payload.imageUrl);
  }

  const createRes = await deps.fetch(`${GRAPH}/${encodeURIComponent(igUserId)}/media`, { method: 'POST', body: createParams });
  if (!createRes.ok) return httpFailure('Instagram create', createRes);
  const created = await readJson(createRes);
  const creationId = created && created.id;
  if (!creationId) return fail('Instagram create returned no id');

  if (isVideo) {
    const w = await waitForContainer(accessToken, creationId, deps);
    if (w.error) return fail(w.error);
  }

  const pubRes = await deps.fetch(`${GRAPH}/${encodeURIComponent(igUserId)}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
  });
  if (!pubRes.ok) return httpFailure('Instagram publish', pubRes);
  const pub = await readJson(pubRes);
  const mediaId = pub && pub.id;

  // Resolve the permalink; the media id alone is not a URL. Hosts that only
  // need the id can skip the extra round-trip with `resolveUrl: false`.
  let url = null;
  if (mediaId && payload.resolveUrl !== false) {
    try {
      const pl = await deps.fetch(`${GRAPH}/${encodeURIComponent(mediaId)}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`);
      if (pl.ok) {
        const j = await readJson(pl);
        url = (j && j.permalink) || null;
      }
    } catch { /* permalink is cosmetic */ }
  }
  return ok({ externalId: mediaId || null, url, status: 'published' });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return { available: false, reason: 'accessToken is required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${GRAPH}/${encodeURIComponent(externalId)}/insights?metric=views,reach,likes,comments,shares,saved&access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) return { available: false, reason: (await httpFailure('Instagram insights', res)).error, status: res.status };
  const j = await readJson(res);
  const byName = {};
  for (const row of (j && j.data) || []) {
    const v = row.values && row.values[0] ? row.values[0].value : row.total_value && row.total_value.value;
    byName[row.name] = typeof v === 'number' ? v : null;
  }
  return {
    available: true,
    metrics: {
      impressions: byName.reach != null ? byName.reach : null,
      views: byName.views != null ? byName.views : null,
      likes: byName.likes != null ? byName.likes : null,
      comments: byName.comments != null ? byName.comments : null,
      shares: byName.shares != null ? byName.shares : null,
      saves: byName.saved != null ? byName.saved : null,
      raw: j,
    },
  };
}

module.exports = { platform: 'instagram', capabilities: PLATFORMS.instagram, validate, publish, fetchMetrics };
