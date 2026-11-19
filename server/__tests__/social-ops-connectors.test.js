/**
 * Connector behaviour with a scripted fetch: request shaping per platform,
 * fail-fast validation with NO network, status classification, and the
 * draft / packaged / pending_review semantics the host state machine relies on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const so = require('../../packages/social-ops');

function scriptedFetch(script) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = script.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    const body = next.body;
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      headers: { get: (k) => (next.headers || {})[k.toLowerCase()] || null },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body || '')),
      arrayBuffer: async () => (next.bytes || Buffer.from('bytes')).buffer.slice(0),
    };
  };
  return { fetch, calls };
}

const noNet = { fetch: async (u) => { throw new Error(`network call not expected: ${u}`); }, sleep: async () => {} };

test('every api connector fails fast on missing credentials without touching the network', async () => {
  for (const c of so.connectors.listConnectors()) {
    if (c.capabilities.publishMode === 'manual_package') continue;
    const r = await c.publish(null, { text: 'hi', title: 't', videoUrl: 'https://x/v.mp4', imageUrl: 'https://x/i.jpg', coverUrl: 'https://x/c.jpg', tags: ['a'], subreddit: 's' }, noNet);
    assert.equal(r.success, false, c.platform);
    assert.equal(r.kind, 'auth', `${c.platform}: ${r.error}`);
  }
});

test('validate() reports input errors per platform without network', () => {
  assert.match(so.connectors.getConnector('x').validate({ text: 'a'.repeat(281) }).join(), /280/);
  assert.match(so.connectors.getConnector('instagram').validate({ text: 'no media' }).join(), /image_url or video_url/);
  assert.match(so.connectors.getConnector('youtube').validate({ text: 'x' }).join(), /video_url/);
  assert.match(so.connectors.getConnector('tiktok').validate({ text: 'x' }).join(), /video_url/);
  assert.match(so.connectors.getConnector('reddit').validate({ text: 'x' }).join(), /subreddit.*title|title.*subreddit/s);
  assert.match(so.connectors.getConnector('wechat_mp').validate({ title: 't', text: '<style>a</style><p>x</p>' }).join(), /inline-styled|cover/);
  assert.match(so.connectors.getConnector('bilibili').validate({ title: 't', text: 'd', videoUrl: 'v' }).join(), /cover|tag/);
  assert.deepEqual(so.connectors.getConnector('discord').validate({ text: 'ok' }), []);
});

test('x: thread posts reply-chain to the head and report all ids', async () => {
  const { fetch, calls } = scriptedFetch([
    { body: { data: { id: '100' } } },
    { body: { data: { id: '101' } } },
    { body: { data: { id: '102' } } },
  ]);
  const r = await so.connectors.getConnector('x').publish({ accessToken: 'T' }, { text: 'head', threadParts: ['two', 'three'] }, { fetch });
  assert.equal(r.success, true);
  assert.equal(r.externalId, '100');
  assert.equal(r.url, 'https://x.com/i/status/100');
  assert.deepEqual(r.threadIds, ['100', '101', '102']);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[1].options.body).reply.in_reply_to_tweet_id, '100');
  assert.equal(JSON.parse(calls[2].options.body).reply.in_reply_to_tweet_id, '101');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer T');
});

test('x: media uses the dedicated v2 upload endpoints (initialize → append → finalize → STATUS)', async () => {
  const c = so.connectors.getConnector('x');
  const size = 4 * 1024 * 1024 + 10; // two segments at the 4 MiB chunk size
  const s = scriptedFetch([
    { body: 'v', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.alloc(size, 1) },
    { body: { data: { id: 'm1', media_key: '7_m1' } } },
    { body: {} },
    { body: {} },
    { body: { data: { id: 'm1', processing_info: { state: 'pending', check_after_secs: 1 } } } },
    { body: { data: { id: 'm1', processing_info: { state: 'succeeded' } } } },
    { body: { data: { id: '200' } } },
  ]);
  const r = await c.publish({ accessToken: 'T' }, { text: 'clip', mediaUrls: ['https://x/v.mp4'] }, { ...s, sleep: async () => {} });
  assert.equal(r.success, true, r.error);
  assert.equal(s.calls[1].url, 'https://api.x.com/2/media/upload/initialize');
  assert.equal(s.calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(s.calls[1].options.body), { media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' });
  assert.equal(s.calls[2].url, 'https://api.x.com/2/media/upload/m1/append');
  assert.equal(s.calls[2].options.body.get('segment_index'), '0');
  assert.equal(s.calls[2].options.body.get('command'), null, 'no legacy command field');
  assert.equal(s.calls[3].url, 'https://api.x.com/2/media/upload/m1/append');
  assert.equal(s.calls[3].options.body.get('segment_index'), '1');
  assert.equal(s.calls[4].url, 'https://api.x.com/2/media/upload/m1/finalize');
  assert.equal(s.calls[4].options.method, 'POST');
  assert.equal(s.calls[5].url, 'https://api.x.com/2/media/upload?command=STATUS&media_id=m1');
  assert.equal(s.calls[6].url, 'https://api.x.com/2/tweets');
  assert.deepEqual(JSON.parse(s.calls[6].options.body).media, { media_ids: ['m1'] });

  // A legacy-shaped initialize answer (no data.id) stops before anything is posted.
  const legacy = scriptedFetch([
    { body: 'i', headers: { 'content-type': 'image/png' }, bytes: Buffer.alloc(3) },
    { body: { media_id_string: '123' } },
  ]);
  const bad = await c.publish({ accessToken: 'T' }, { text: 'img', mediaUrls: ['https://x/i.png'] }, legacy);
  assert.equal(bad.success, false);
  assert.match(bad.error, /no media id/);
  assert.equal(legacy.calls.length, 2);
  assert.equal(JSON.parse(legacy.calls[1].options.body).media_category, 'tweet_image');
});

test('x: 429 is retryable, 403 is auth; metrics unavailable on free tier is not an error', async () => {
  const c = so.connectors.getConnector('x');
  const r429 = await c.publish({ accessToken: 'T' }, { text: 'x' }, scriptedFetch([{ ok: false, status: 429, body: 'slow down' }]));
  assert.equal(r429.success, false);
  assert.equal(r429.retryable, true);
  assert.equal(r429.kind, 'rate_limit');
  const r403 = await c.publish({ accessToken: 'T' }, { text: 'x' }, scriptedFetch([{ ok: false, status: 403, body: 'nope' }]));
  assert.equal(r403.kind, 'auth');
  assert.equal(r403.retryable, false);
  const m = await c.fetchMetrics({ accessToken: 'T' }, '100', scriptedFetch([{ ok: false, status: 403, body: {} }]));
  assert.equal(m.available, false);
  assert.match(m.reason, /tier/);
  const m2 = await c.fetchMetrics({ accessToken: 'T' }, '100', scriptedFetch([{ body: { data: { public_metrics: { impression_count: 10, like_count: 2, reply_count: 1, retweet_count: 1, quote_count: 1, bookmark_count: 3 } } } }]));
  assert.equal(m2.available, true);
  assert.equal(m2.metrics.impressions, 10);
  assert.equal(m2.metrics.shares, 2);
  assert.equal(m2.metrics.saves, 3);
});

test('instagram: container → publish → permalink; reels poll container status', async () => {
  const c = so.connectors.getConnector('instagram');
  const img = scriptedFetch([
    { body: { id: 'cont-1' } },
    { body: { id: 'media-9' } },
    { body: { permalink: 'https://www.instagram.com/p/abc/' } },
  ]);
  const r = await c.publish({ accessToken: 'PT', igUserId: 'ig-1' }, { text: 'cap', imageUrl: 'https://x/i.jpg' }, img);
  assert.equal(r.success, true);
  assert.equal(r.externalId, 'media-9');
  assert.equal(r.url, 'https://www.instagram.com/p/abc/');
  assert.ok(img.calls[0].url.includes('/ig-1/media'));
  assert.ok(String(img.calls[0].options.body).includes('image_url=https'));

  const reel = scriptedFetch([
    { body: { id: 'cont-2' } },
    { body: { status_code: 'IN_PROGRESS' } },
    { body: { status_code: 'FINISHED' } },
    { body: { id: 'media-10' } },
    { body: { permalink: 'https://www.instagram.com/reel/xyz/' } },
  ]);
  const r2 = await c.publish({ accessToken: 'PT', igUserId: 'ig-1' }, { text: 'cap', videoUrl: 'https://x/v.mp4', aiGenerated: true }, { ...reel, sleep: async () => {} });
  assert.equal(r2.success, true);
  assert.ok(String(reel.calls[0].options.body).includes('media_type=REELS'));
  assert.equal(reel.calls.length, 5);
  for (const call of [...img.calls, ...reel.calls]) assert.ok(call.url.startsWith('https://graph.facebook.com/v26.0/'), call.url);
  // AI label only when the payload says so.
  assert.equal(new URLSearchParams(String(reel.calls[0].options.body)).get('is_ai_generated'), 'true');
  assert.equal(new URLSearchParams(String(img.calls[0].options.body)).get('is_ai_generated'), null);
});

test('instagram: fetchPublishingLimit reads content_publishing_limit (data[] or bare) and never writes', async () => {
  const c = so.connectors.getConnector('instagram');
  const s = scriptedFetch([{ body: { data: [{ quota_usage: 12, config: { quota_total: 50, quota_duration: 86400 } }] } }]);
  const r = await c.fetchPublishingLimit({ accessToken: 'PT', igUserId: 'ig-1' }, s);
  assert.deepEqual({ ...r }, { success: true, used: 12, total: 50, windowSeconds: 86400, remaining: 38 });
  const u = new URL(s.calls[0].url);
  assert.equal(u.pathname, '/v26.0/ig-1/content_publishing_limit');
  assert.equal(u.searchParams.get('fields'), 'config,quota_usage');
  assert.equal(s.calls[0].options.method, undefined, 'a GET');

  const bare = await c.fetchPublishingLimit({ accessToken: 'PT', igUserId: 'ig-1' }, scriptedFetch([{ body: { quota_usage: 60, config: { quota_total: 50 } } }]));
  assert.equal(bare.remaining, 0);
  const noConfig = await c.fetchPublishingLimit({ accessToken: 'PT', igUserId: 'ig-1' }, scriptedFetch([{ body: { data: [{ quota_usage: 3 }] } }]));
  assert.equal(noConfig.total, null);
  assert.equal(noConfig.remaining, null);
  const empty = await c.fetchPublishingLimit({ accessToken: 'PT', igUserId: 'ig-1' }, scriptedFetch([{ body: { data: [] } }]));
  assert.equal(empty.success, false);
  const denied = await c.fetchPublishingLimit({ accessToken: 'PT', igUserId: 'ig-1' }, scriptedFetch([{ ok: false, status: 403, body: 'no' }]));
  assert.equal(denied.kind, 'auth');
  const noCreds = await c.fetchPublishingLimit({ accessToken: 'PT' }, noNet);
  assert.equal(noCreds.kind, 'auth');
});

test('youtube: resumable upload, private by default, scheduled forces private + publishAt', async () => {
  const c = so.connectors.getConnector('youtube');
  const s = scriptedFetch([
    { body: 'video', headers: { 'content-type': 'video/mp4', 'content-length': '5' }, bytes: Buffer.from('video') },
    { body: {}, headers: { location: 'https://upload/session' } },
    { body: { id: 'vid-1' } },
  ]);
  const r = await c.publish({ accessToken: 'T' }, { title: 'T', text: 'desc', videoUrl: 'https://x/v.mp4', publishAt: '2026-10-01T00:00:00Z' }, s);
  assert.equal(r.success, true);
  assert.equal(r.status, 'scheduled');
  assert.equal(r.url, 'https://www.youtube.com/watch?v=vid-1');
  const meta = JSON.parse(s.calls[1].options.body);
  assert.equal(meta.status.privacyStatus, 'private');
  assert.equal(meta.status.publishAt, '2026-10-01T00:00:00Z');
  assert.equal(s.calls[2].options.method, 'PUT');
  // videos.insert is billed to the separate upload bucket at 1 unit (since 2026-06).
  assert.equal(r.quotaBucket, 'video_uploads');
  assert.equal(r.quotaUnits, 1);
  assert.equal('containsSyntheticMedia' in meta.status, false, 'no AI field unless asked');

  const ai = scriptedFetch([
    { body: 'video', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.from('video') },
    { body: {}, headers: { location: 'https://upload/session' } },
    { body: { id: 'vid-2' } },
  ]);
  const r2 = await c.publish({ accessToken: 'T' }, { title: 'T', videoUrl: 'https://x/v.mp4', aiGenerated: true }, ai);
  assert.equal(r2.success, true);
  const meta2 = JSON.parse(ai.calls[1].options.body);
  assert.equal(meta2.status.containsSyntheticMedia, true);
  assert.equal(meta2.status.privacyStatus, 'private');
});

test('tiktok: SELF_ONLY draft by default → requiresHumanFinalStep; public when audited', async () => {
  const c = so.connectors.getConnector('tiktok');
  const s = scriptedFetch([{ body: { data: { publish_id: 'p1' }, error: { code: 'ok' } } }]);
  const r = await c.publish({ accessToken: 'T' }, { text: 'cap', videoUrl: 'https://x/v.mp4' }, s);
  assert.equal(r.status, 'draft');
  assert.equal(r.requiresHumanFinalStep, true);
  assert.equal(JSON.parse(s.calls[0].options.body).post_info.privacy_level, 'SELF_ONLY');
  assert.equal('is_aigc' in JSON.parse(s.calls[0].options.body).post_info, false, 'no AI field unless asked');
  const s2 = scriptedFetch([{ body: { data: { publish_id: 'p2' }, error: { code: 'ok' } } }]);
  const r2 = await c.publish({ accessToken: 'T' }, { text: 'cap', videoUrl: 'https://x/v.mp4', privacyLevel: 'PUBLIC_TO_EVERYONE', aiGenerated: true }, s2);
  assert.equal(r2.status, 'pending_review');
  assert.equal(r2.requiresHumanFinalStep, false);
  assert.equal(JSON.parse(s2.calls[0].options.body).post_info.is_aigc, true);
  const bad = await c.publish({ accessToken: 'T' }, { text: 'cap', videoUrl: 'https://x/v.mp4' }, scriptedFetch([{ body: { error: { code: 'scope_not_authorized', message: 'no' } } }]));
  assert.equal(bad.success, false);
  assert.match(bad.error, /scope_not_authorized/);
});

test('reddit: publish() is a manual package — no network, no credentials, deterministic id', async () => {
  const c = so.connectors.getConnector('reddit');
  const payload = { subreddit: 'r/Test', title: 'Hello', text: 'body' };
  const a = await c.publish(null, payload, noNet);
  const b = await c.publish({ accessToken: 'ignored' }, { ...payload, subreddit: 'test' }, noNet);
  assert.equal(a.success, true, a.error);
  assert.equal(a.status, 'packaged');
  assert.equal(a.requiresHumanFinalStep, true);
  assert.equal(a.url, null);
  assert.match(a.externalId, /^reddit:[0-9a-f]{16}$/);
  assert.equal(a.externalId, b.externalId, 'r/Test and test are the same subreddit');
  assert.equal(a.package.subreddit, 'Test');
  assert.equal(a.package.submitUrl, 'https://www.reddit.com/r/Test/submit');
  assert.equal(a.package.kind, 'self');
  assert.equal(a.package.body, 'body');
  assert.ok(a.package.steps.some((st) => /7:1/.test(st)));
  const link = await c.publish(null, { subreddit: 'test', title: 'Hello', link: 'https://cuddler.ai' }, noNet);
  assert.equal(link.package.kind, 'link');
  assert.equal(link.package.body, null);
  assert.notEqual(link.externalId, a.externalId);
  const bad = await c.publish(null, { subreddit: 'test', text: 'no title' }, noNet);
  assert.equal(bad.success, false);
  assert.equal(bad.kind, 'client');
  assert.equal((await c.publish(null, { subreddit: 'test', title: 't', text: 'x', link: 'https://cuddler.ai' }, noNet)).success, false);
});

test('reddit: submit() keeps the API path — self post form + descriptive UA; RATELIMIT api error is retryable', async () => {
  const c = so.connectors.getConnector('reddit');
  const s = scriptedFetch([{ body: { json: { errors: [], data: { id: 'abc', name: 't3_abc', url: 'https://www.reddit.com/r/test/comments/abc/x/' } } } }]);
  const r = await c.submit({ accessToken: 'T' }, { subreddit: 'r/test', title: 'Hello', text: 'body' }, s);
  assert.equal(r.success, true);
  assert.equal(r.fullname, 't3_abc');
  const body = String(s.calls[0].options.body);
  assert.ok(body.includes('sr=test') && body.includes('kind=self') && body.includes('sendreplies=true'));
  assert.match(s.calls[0].options.headers['User-Agent'], /influencex/);
  const noToken = await c.submit(null, { subreddit: 'test', title: 'x', text: 'y' }, noNet);
  assert.equal(noToken.kind, 'auth');
  const rl = await c.submit({ accessToken: 'T' }, { subreddit: 'test', title: 'x', text: 'y' }, scriptedFetch([{ body: { json: { errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']] } } }]));
  assert.equal(rl.success, false);
  assert.equal(rl.retryable, true);
  const rules = await c.fetchSubredditRules({ accessToken: 'T' }, 'test', scriptedFetch([{ body: { rules: [{ short_name: 'No self-promotion', description: 'x' }] } }]));
  assert.equal(rules.rules[0].shortName, 'No self-promotion');
});

test('discord: bot mode posts to channel with allowed_mentions off; webhook mode requires a discord.com url', async () => {
  const c = so.connectors.getConnector('discord');
  const s = scriptedFetch([{ body: { id: 'm1', guild_id: 'g1' } }]);
  const r = await c.publish({ botToken: 'B', channelId: 'ch' }, { text: 'hi', embed: { title: 'T', description: 'D', url: 'https://cuddler.ai' } }, s);
  assert.equal(r.success, true);
  assert.equal(r.url, 'https://discord.com/channels/g1/ch/m1');
  assert.equal(s.calls[0].options.headers.Authorization, 'Bot B');
  const body = JSON.parse(s.calls[0].options.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.embeds[0].title, 'T');
  const bad = await c.publish({ webhookUrl: 'https://evil.example/hook' }, { text: 'hi' }, noNet);
  assert.equal(bad.success, false);
  assert.equal(bad.kind, 'auth');
  const w = scriptedFetch([{ body: { id: 'm2' } }]);
  const ok = await c.publish({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' }, { text: 'hi' }, w);
  assert.equal(ok.mode, 'webhook');
  assert.ok(w.calls[0].url.endsWith('?wait=true'));
  const m = await c.fetchMetrics({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' }, 'm2', noNet);
  assert.equal(m.available, false);
});

test('wechat_mp: token → cover material → draft/add; publish() stops at the draft, submitPublish is separate', async () => {
  const c = so.connectors.getConnector('wechat_mp');
  const s = scriptedFetch([
    { body: { access_token: 'AT', expires_in: 7200 } },
    { body: 'img', headers: { 'content-type': 'image/jpeg' }, bytes: Buffer.from('img') },
    { body: { media_id: 'thumb-1', url: 'https://mmbiz/x' } },
    { body: { media_id: 'draft-1' } },
  ]);
  const r = await c.publish({ appId: 'wx', appSecret: 's' }, { title: '标题', text: '<p style="x">正文</p>', coverUrl: 'https://x/c.jpg', digest: '摘要' }, s);
  assert.equal(r.success, true);
  assert.equal(r.status, 'draft');
  assert.equal(r.requiresHumanFinalStep, true);
  assert.equal(r.externalId, 'draft-1');
  assert.ok(s.calls[0].url.includes('grant_type=client_credential'));
  assert.ok(s.calls[2].url.includes('material/add_material'));
  const draft = JSON.parse(s.calls[3].options.body).articles[0];
  assert.equal(draft.thumb_media_id, 'thumb-1');
  assert.equal(draft.title, '标题');
  const ipErr = await c.publish({ appId: 'wx', appSecret: 's' }, { title: 't', text: '<p>x</p>', coverUrl: 'https://x/c.jpg' }, scriptedFetch([{ body: { errcode: 40164, errmsg: 'invalid ip 1.2.3.4' } }]));
  assert.equal(ipErr.success, false);
  assert.match(ipErr.error, /40164.*allowlist/);
  const sub = await c.submitPublish({ accessToken: 'AT' }, 'draft-1', scriptedFetch([{ body: { errcode: 0, publish_id: 'pub-1' } }]));
  assert.equal(sub.externalId, 'pub-1');
  assert.equal(sub.status, 'pending_review');
});

test('manual connectors package instead of posting, deterministically', async () => {
  const xhs = so.connectors.getConnector('xiaohongshu');
  const payload = { title: '标题', text: '正文 #tag', mediaUrls: ['https://x/1.jpg'] };
  const a = await xhs.publish(null, payload, noNet);
  const b = await xhs.publish(null, payload, noNet);
  assert.equal(a.status, 'packaged');
  assert.equal(a.requiresHumanFinalStep, true);
  assert.equal(a.externalId, b.externalId);
  assert.match(a.externalId, /^xiaohongshu:[0-9a-f]{16}$/);
  assert.deepEqual(a.package.hashtags, ['tag']);
  assert.ok(a.package.steps.length >= 3);
  const tooLong = await xhs.publish(null, { title: 'x'.repeat(21), text: 'y' }, noNet);
  assert.equal(tooLong.success, false);
  const ch = await so.connectors.getConnector('wechat_channels').publish(null, { text: 'd', videoUrl: 'https://x/v.mp4' }, noNet);
  assert.equal(ch.package.coverSpec, '1080x1260');
});

test('douyin / kuaishou / bilibili: shape the documented flows and surface platform error codes', async () => {
  const dy = so.connectors.getConnector('douyin');
  const s = scriptedFetch([
    { body: 'v', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.from('v') },
    { body: { data: { error_code: 0, video: { video_id: 'v1' } } } },
    { body: { data: { error_code: 0, item_id: 'item-1' } } },
  ]);
  const r = await dy.publish({ accessToken: 'T', openId: 'o' }, { text: '文案', videoUrl: 'https://x/v.mp4' }, s);
  assert.equal(r.success, true);
  assert.equal(r.status, 'pending_review');
  assert.ok(s.calls[1].url.includes('upload_video/?open_id=o'));
  assert.equal(s.calls[1].options.headers['access-token'], 'T');
  assert.equal(JSON.parse(s.calls[2].options.body).video_id, 'v1');
  const dyErr = await dy.publish({ accessToken: 'T', openId: 'o' }, { text: 'x', videoUrl: 'https://x/v.mp4' }, scriptedFetch([
    { body: 'v', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.from('v') },
    { body: { data: { error_code: 2190008, description: 'access_token expired' } } },
  ]));
  assert.equal(dyErr.kind, 'auth');

  const ks = so.connectors.getConnector('kuaishou');
  const k = scriptedFetch([
    { body: { result: 1, upload_token: 'ut', endpoint: 'upload.example' } },
    { body: 'v', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.from('v') },
    { body: { result: 1 } },
    { body: { result: 1, video_info: { photo_id: 'ph-1' } } },
  ]);
  const kr = await ks.publish({ accessToken: 'T', appId: 'ks' }, { text: 'cap', videoUrl: 'https://x/v.mp4' }, k);
  assert.equal(kr.externalId, 'ph-1');
  assert.ok(k.calls[2].url.startsWith('https://upload.example/api/upload?upload_token=ut'));

  const bili = so.connectors.getConnector('bilibili');
  const b = scriptedFetch([
    { body: 'v', headers: { 'content-type': 'video/mp4' }, bytes: Buffer.from('v') },
    { body: { code: 0, data: { upload_token: 'tok' } } },
    { body: { code: 0 } },
    { body: { code: 0, data: {} } },
    { body: 'c', headers: { 'content-type': 'image/jpeg' }, bytes: Buffer.from('c') },
    { body: { code: 0, data: { url: 'https://i0.hdslb.com/cover.jpg' } } },
    { body: { code: 0, data: { resource_id: 'res-1' } } },
  ]);
  const br = await bili.publish({ accessToken: 'T', clientId: 'cid', clientSecret: 'sec' }, { title: 't', text: 'd', videoUrl: 'https://x/v.mp4', coverUrl: 'https://x/c.jpg', tags: ['tag'] }, b);
  assert.equal(br.success, true, br.error);
  assert.equal(br.externalId, 'res-1');
  const h = b.calls[1].options.headers;
  assert.equal(h['x-bili-accesskeyid'], 'cid');
  assert.equal(h['x-bili-signature-method'], 'HMAC-SHA256');
  assert.match(h.Authorization, /^[0-9a-f]{64}$/);
  assert.equal(h['Access-Token'], 'T');
  assert.equal(JSON.parse(b.calls[6].options.body).tag, 'tag');
});

test('oauth: authorize urls carry PKCE / provider quirks; exchange is pure and resolves identity', async () => {
  const x = so.oauth.buildAuthorizeUrl('x', { clientId: 'cid', redirectUri: 'https://cuddler.ai/cb' });
  const xu = new URL(x.url);
  assert.equal(xu.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(x.codeVerifier);
  assert.ok(xu.searchParams.get('scope').includes('offline.access'));
  const tt = new URL(so.oauth.buildAuthorizeUrl('tiktok', { clientId: 'k', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.equal(tt.searchParams.get('client_key'), 'k');
  assert.equal(tt.searchParams.get('client_id'), null);
  const rd = new URL(so.oauth.buildAuthorizeUrl('reddit', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.equal(rd.searchParams.get('duration'), 'permanent');
  const yt = new URL(so.oauth.buildAuthorizeUrl('youtube', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.equal(yt.searchParams.get('access_type'), 'offline');
  const ig = new URL(so.oauth.buildAuthorizeUrl('instagram', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.equal(ig.origin + ig.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  assert.equal(so.oauth.getProvider('instagram').tokenUrl, 'https://graph.facebook.com/v26.0/oauth/access_token');
  const bl = new URL(so.oauth.buildAuthorizeUrl('bilibili', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.equal(bl.searchParams.get('gourl'), 'https://cuddler.ai/cb');
  assert.throws(() => so.oauth.buildAuthorizeUrl('x', { redirectUri: 'x' }), /clientId/);
  assert.throws(() => so.oauth.buildAuthorizeUrl('discord', { clientId: 'c', redirectUri: 'x' }), /Unknown OAuth provider/);

  const s = scriptedFetch([
    { body: { access_token: 'AT', refresh_token: 'RT', expires_in: 7200, scope: 'tweet.write' } },
    { body: { data: { id: '42', username: 'cuddlerai' } } },
  ]);
  const ex = await so.oauth.exchangeCode('x', { clientId: 'cid', clientSecret: 'sec', code: 'code', redirectUri: 'https://cuddler.ai/cb', codeVerifier: 'ver' }, s);
  assert.equal(ex.accessToken, 'AT');
  assert.equal(ex.refreshToken, 'RT');
  assert.deepEqual(ex.account, { id: '42', name: '@cuddlerai' });
  assert.match(s.calls[0].options.headers.Authorization, /^Basic /);
  assert.ok(String(s.calls[0].options.body).includes('code_verifier=ver'));

  const dyx = scriptedFetch([{ body: { data: { access_token: 'A', open_id: 'oid', expires_in: 1, refresh_token: 'R' }, message: 'success' } }]);
  const dy = await so.oauth.exchangeCode('douyin', { clientId: 'k', clientSecret: 's', code: 'c' }, dyx);
  assert.equal(dy.account.id, 'oid');
  assert.equal(dy.metadata.openId, 'oid');
  assert.ok(String(dyx.calls[0].options.body).includes('client_key=k'));

  const rf = await so.oauth.refreshAccessToken('x', { clientId: 'cid', clientSecret: 'sec', refreshToken: 'RT' }, scriptedFetch([{ body: { access_token: 'AT2' } }]));
  assert.equal(rf.accessToken, 'AT2');
  assert.equal(rf.refreshToken, 'RT');
  assert.equal(rf.refreshExpiresIn, null);

  // TikTok rotates the refresh token on every refresh and reports its own lifetime.
  const ttr = scriptedFetch([{ body: { access_token: 'TA2', expires_in: 7200, refresh_token: 'TR2', refresh_expires_in: 15552000, open_id: 'o' } }]);
  const tr = await so.oauth.refreshAccessToken('tiktok', { clientId: 'k', clientSecret: 's', refreshToken: 'TR1' }, ttr);
  assert.equal(tr.refreshToken, 'TR2');
  assert.equal(tr.expiresIn, 7200);
  assert.equal(tr.refreshExpiresIn, 180 * 86400);
});

test('oauth: instagram identity resolution uses the matrix Graph version on every call', async () => {
  const s = scriptedFetch([
    { body: { access_token: 'short', token_type: 'bearer' } },
    { body: { access_token: 'long', expires_in: 5183944 } },
    { body: { data: [{ id: 'pg-1', name: 'Cuddler', access_token: 'page', instagram_business_account: { id: 'ig-9' } }] } },
    { body: { username: 'cuddlerai' } },
  ]);
  const ex = await so.oauth.exchangeCode('instagram', { clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'https://cuddler.ai/cb' }, s);
  assert.equal(ex.account.id, 'ig-9');
  assert.equal(ex.account.name, '@cuddlerai');
  assert.equal(s.calls.length, 4);
  for (const call of s.calls) assert.ok(call.url.startsWith('https://graph.facebook.com/v26.0/'), call.url);
});
