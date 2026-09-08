'use strict';

/**
 * Reddit connector — self / link posts, comments, subreddit rules.
 *
 * credentials: { accessToken }
 * payload:     { subreddit, title, text? | link?, flairId?, flairText?, nsfw?, spoiler?, sendReplies? }
 *
 * Reddit is community-governed: the connector will post, but whether it
 * SHOULD is decided by community/playbook (contribution ratio, subreddit rules,
 * disclosure). Every request carries a descriptive User-Agent — Reddit blocks
 * the default one.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps } = require('../result');

const OAUTH = 'https://oauth.reddit.com';

function headers(accessToken, deps, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, 'User-Agent': deps.userAgent, ...extra };
}

function normalizeSubreddit(s) {
  return String(s || '').replace(/^\/?r\//i, '').trim();
}

function validate(payload = {}) {
  const errors = [];
  if (!payload.subreddit) errors.push('Reddit requires a subreddit (e.g. "test")');
  if (!payload.title) errors.push('Reddit submissions require a title');
  if ((payload.title || '').length > PLATFORMS.reddit.text.titleMaxLength) errors.push(`title exceeds ${PLATFORMS.reddit.text.titleMaxLength} characters`);
  if ((payload.text || '').length > PLATFORMS.reddit.text.maxLength) errors.push(`text exceeds ${PLATFORMS.reddit.text.maxLength} characters`);
  if (payload.text && payload.link) errors.push('a submission is either a self post (text) or a link post (link), not both');
  return errors;
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('reddit: accessToken is required', { kind: 'auth' });
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });

  const body = new URLSearchParams({
    sr: normalizeSubreddit(payload.subreddit),
    kind: payload.link ? 'link' : 'self',
    title: String(payload.title).slice(0, PLATFORMS.reddit.text.titleMaxLength),
    api_type: 'json',
    resubmit: 'true',
    sendreplies: payload.sendReplies === false ? 'false' : 'true',
    nsfw: payload.nsfw === true ? 'true' : 'false',
    spoiler: payload.spoiler === true ? 'true' : 'false',
  });
  if (payload.link) body.set('url', payload.link);
  else body.set('text', payload.text || '');
  if (payload.flairId) body.set('flair_id', payload.flairId);
  if (payload.flairText) body.set('flair_text', payload.flairText);

  const res = await deps.fetch(`${OAUTH}/api/submit`, {
    method: 'POST',
    headers: headers(accessToken, deps, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
  });
  if (!res.ok) return httpFailure('Reddit API', res);
  const data = await readJson(res);
  const errs = data && data.json && data.json.errors;
  if (errs && errs.length) {
    const msg = errs.map((e) => (Array.isArray(e) ? e.join(':') : String(e))).join('; ');
    return fail(`Reddit: ${msg}`, { kind: /RATELIMIT/i.test(msg) ? 'rate_limit' : 'client', retryable: /RATELIMIT/i.test(msg) });
  }
  const sub = (data && data.json && data.json.data) || {};
  return ok({ externalId: sub.id || sub.name || null, url: sub.url || null, status: 'published', fullname: sub.name || null });
}

/** Reply to a post (t3_) or comment (t1_) by fullname. */
async function comment(credentials, { parentFullname, text } = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('reddit: accessToken is required', { kind: 'auth' });
  if (!parentFullname || !/^t[13]_/.test(parentFullname)) return fail('parentFullname must be a t1_/t3_ fullname', { kind: 'client' });
  if (!text) return fail('text is required', { kind: 'client' });
  const res = await deps.fetch(`${OAUTH}/api/comment`, {
    method: 'POST',
    headers: headers(accessToken, deps, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams({ api_type: 'json', thing_id: parentFullname, text }).toString(),
  });
  if (!res.ok) return httpFailure('Reddit comment', res);
  const data = await readJson(res);
  const errs = data && data.json && data.json.errors;
  if (errs && errs.length) return fail(`Reddit: ${errs.map((e) => e.join(':')).join('; ')}`, { kind: 'client' });
  const thing = data && data.json && data.json.data && data.json.data.things && data.json.data.things[0];
  const d = (thing && thing.data) || {};
  return ok({ externalId: d.id || null, url: d.permalink ? `https://www.reddit.com${d.permalink}` : null, fullname: d.name || null });
}

/** Subreddit rules — the input to community/playbook's promotion assessment. */
async function fetchSubredditRules(credentials, subreddit, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return fail('reddit: accessToken is required', { kind: 'auth' });
  const sr = normalizeSubreddit(subreddit);
  if (!sr) return fail('subreddit is required', { kind: 'client' });
  const res = await deps.fetch(`${OAUTH}/r/${encodeURIComponent(sr)}/about/rules`, { headers: headers(accessToken, deps) });
  if (!res.ok) return httpFailure('Reddit rules', res);
  const j = await readJson(res);
  const rules = ((j && j.rules) || []).map((r) => ({ shortName: r.short_name || '', description: r.description || '', kind: r.kind || 'all' }));
  return ok({ subreddit: sr, rules, raw: j });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const accessToken = credentials && credentials.accessToken;
  if (!accessToken) return { available: false, reason: 'accessToken is required' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const fullname = /^t3_/.test(externalId) ? externalId : `t3_${externalId}`;
  const res = await deps.fetch(`${OAUTH}/api/info?id=${encodeURIComponent(fullname)}`, { headers: headers(accessToken, deps) });
  if (!res.ok) return { available: false, reason: (await httpFailure('Reddit info', res)).error, status: res.status };
  const j = await readJson(res);
  const d = (j && j.data && j.data.children && j.data.children[0] && j.data.children[0].data) || null;
  if (!d) return { available: false, reason: 'post not found' };
  return {
    available: true,
    metrics: { impressions: null, views: null, likes: d.ups ?? d.score ?? null, comments: d.num_comments ?? null, shares: null, saves: null, upvoteRatio: d.upvote_ratio ?? null, raw: j },
  };
}

module.exports = { platform: 'reddit', capabilities: PLATFORMS.reddit, validate, publish, comment, fetchSubredditRules, fetchMetrics, normalizeSubreddit };
