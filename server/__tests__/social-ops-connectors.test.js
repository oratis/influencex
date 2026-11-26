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
  assert.equal(bad.error, 'TikTok init 200: scope_not_authorized');
  assert.equal(bad.kind, 'auth');
});

test('tiktok: publish init failures use local text and classify documented codes', async () => {
  const c = so.connectors.getConnector('tiktok');
  const payload = { text: 'cap', videoUrl: 'https://x/v.mp4' };
  const init = (status, body) => c.publish({ accessToken: 'SECRET' }, payload, scriptedFetch([{ ok: false, status, body }]));
  const policy = ['spam_risk_too_many_posts', 'spam_risk_user_banned_from_posting', 'reached_active_user_cap',
    'unaudited_client_can_only_post_to_private_accounts', 'url_ownership_unverified', 'privacy_level_option_mismatch'];
  for (const code of policy) {
    const r = await init(403, { error: { code, message: 'Bearer SECRET leaked' } });
    assert.equal(r.kind, 'policy', code);
    assert.equal(r.retryable, false, code);
    assert.equal(r.status, 403);
    assert.equal(r.error, `TikTok init 403: ${code}`);
  }
  const invalid = await init(400, { error: { code: 'invalid_param', message: 'url is bad' } });
  assert.deepEqual([invalid.kind, invalid.retryable, invalid.error], ['client', false, 'TikTok init 400: invalid_param']);
  const limited = await init(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } });
  assert.deepEqual([limited.kind, limited.retryable, limited.error], ['rate_limit', true, 'TikTok init 429: rate_limit_exceeded']);
  const down = await init(502, '<html>Bearer SECRET bad gateway</html>');
  assert.deepEqual([down.kind, down.retryable, down.error], ['server', true, 'TikTok init 502: unrecognized_error']);
  const unknown403 = await init(403, { error: { code: 'something_new', message: 'Bearer SECRET' } });
  assert.deepEqual([unknown403.kind, unknown403.retryable, unknown403.error], ['client', false, 'TikTok init 403: unrecognized_error']);
  const http401 = await init(401, { error: { code: 'access_token_invalid', message: 'Bearer SECRET' } });
  assert.deepEqual([http401.kind, http401.error], ['auth', 'TikTok init 401: access_token_invalid']);
  const bare401 = await init(401, 'Bearer SECRET');
  assert.deepEqual([bare401.kind, bare401.error], ['auth', 'TikTok init 401: unrecognized_error']);
});

test('tiktok: fetchCreatorInfo posts to creator_info/query with bearer token and maps the creator', async () => {
  const c = so.connectors.getConnector('tiktok');
  const s = scriptedFetch([{ body: { error: { code: 'ok' }, data: {
    creator_nickname: 'Nick', creator_username: 'nick_u', creator_avatar_url: 'https://x/a.jpg',
    privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    comment_disabled: true, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600,
  } } }]);
  const r = await c.fetchCreatorInfo({ accessToken: 'T' }, s);
  assert.equal(s.calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/');
  assert.equal(s.calls[0].options.method, 'POST');
  assert.equal(s.calls[0].options.headers.Authorization, 'Bearer T');
  assert.equal(s.calls[0].options.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(s.calls[0].options.body, undefined);
  assert.deepEqual(r, { success: true, creator: {
    nickname: 'Nick', username: 'nick_u', avatarUrl: 'https://x/a.jpg',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    commentDisabled: true, duetDisabled: false, stitchDisabled: true, maxVideoPostDurationSec: 600,
  } });
  const settings = { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false };
  for (const [max, want] of [[0, null], [-5, null], ['600', null], [Infinity, null], [null, null], [90.5, 90.5]]) {
    const m = await c.fetchCreatorInfo({ accessToken: 'T' }, scriptedFetch([{ body: { error: { code: 'ok' }, data: { ...settings, max_video_post_duration_sec: max } } }]));
    assert.equal(m.creator.maxVideoPostDurationSec, want, String(max));
  }
});

test('tiktok: fetchCreatorInfo never reports success without usable settings', async () => {
  const c = so.connectors.getConnector('tiktok');
  const good = { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false };
  const unusable = [
    ['sparse data', { error: { code: 'ok' }, data: {} }],
    ['no data', { error: { code: 'ok' } }],
    ['data is an array', { error: { code: 'ok' }, data: [] }],
    ['no error envelope', { data: good }],
    ['privacy options not an array', { error: { code: 'ok' }, data: { ...good, privacy_level_options: 'SELF_ONLY' } }],
    ['privacy options with a non-string', { error: { code: 'ok' }, data: { ...good, privacy_level_options: ['SELF_ONLY', 3] } }],
    ['comment_disabled missing', { error: { code: 'ok' }, data: { ...good, comment_disabled: undefined } }],
    ['duet_disabled not boolean', { error: { code: 'ok' }, data: { ...good, duet_disabled: 'false' } }],
    ['stitch_disabled not boolean', { error: { code: 'ok' }, data: { ...good, stitch_disabled: 0 } }],
    ['HTML 200', '<html>maintenance</html>'],
  ];
  for (const [name, body] of unusable) {
    const r = await c.fetchCreatorInfo({ accessToken: 'T' }, scriptedFetch([{ body }]));
    assert.equal(r.success, false, name);
    assert.equal(r.error, 'TikTok creator_info: unreadable response', name);
    assert.equal(r.kind, 'server', name);
    assert.equal(r.retryable, true, name);
    assert.equal(r.creator, undefined, name);
  }
});

test('tiktok: fetchCreatorInfo classifies failures and never forwards upstream text', async () => {
  const c = so.connectors.getConnector('tiktok');
  const noToken = await c.fetchCreatorInfo(null, noNet);
  assert.equal(noToken.success, false);
  assert.equal(noToken.kind, 'auth');
  const leak = { error: { code: 'scope_not_authorized', message: 'Bearer SECRET is not allowed', log_id: 'L1' } };
  const http401 = await c.fetchCreatorInfo({ accessToken: 'SECRET' }, scriptedFetch([{ ok: false, status: 401, body: leak }]));
  assert.deepEqual([http401.success, http401.kind, http401.retryable, http401.status], [false, 'auth', false, 401]);
  assert.equal(http401.error, 'TikTok creator_info 401: scope_not_authorized');
  const plain401 = await c.fetchCreatorInfo({ accessToken: 'SECRET' }, scriptedFetch([{ ok: false, status: 401, body: 'Bearer SECRET nope' }]));
  assert.equal(plain401.error, 'TikTok creator_info 401: unrecognized_error');
  assert.equal(plain401.kind, 'auth');
  for (const code of ['access_token_invalid', 'scope_not_authorized']) {
    const r = await c.fetchCreatorInfo({ accessToken: 'SECRET' }, scriptedFetch([{ body: { error: { code, message: 'Bearer SECRET' } } }]));
    assert.equal(r.kind, 'auth', code);
    assert.equal(r.error, `TikTok creator_info 200: ${code}`);
  }
  const policy = await c.fetchCreatorInfo({ accessToken: 'SECRET' }, scriptedFetch([{ ok: false, status: 403, body: { error: { code: 'spam_risk_too_many_posts', message: 'Bearer SECRET' } } }]));
  assert.deepEqual([policy.kind, policy.retryable, policy.error], ['policy', false, 'TikTok creator_info 403: spam_risk_too_many_posts']);
  const odd = await c.fetchCreatorInfo({ accessToken: 'SECRET' }, scriptedFetch([{ body: { error: { code: 'Bearer SECRET', message: 'Bearer SECRET' } } }]));
  assert.equal(odd.success, false);
  assert.equal(odd.error, 'TikTok creator_info 200: unrecognized_error');
  assert.equal(odd.kind, 'client');
  const proto = await c.fetchCreatorInfo({ accessToken: 'T' }, scriptedFetch([{ ok: false, status: 400, body: { error: { code: 'constructor' } } }]));
  assert.equal(proto.error, 'TikTok creator_info 400: unrecognized_error');
  const limited = await c.fetchCreatorInfo({ accessToken: 'T' }, scriptedFetch([{ ok: false, status: 429, body: '' }]));
  assert.deepEqual([limited.kind, limited.retryable], ['rate_limit', true]);
  const down = await c.fetchCreatorInfo({ accessToken: 'T' }, scriptedFetch([{ ok: false, status: 503, body: 'Bearer SECRET' }]));
  assert.deepEqual([down.kind, down.retryable, down.error], ['server', true, 'TikTok creator_info 503: unrecognized_error']);
});

test('tiktok: fetchPublishStatus keeps 19-digit post ids exact (as strings)', async () => {
  const c = so.connectors.getConnector('tiktok');
  const raw = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7445813391838234123, 7445813391838234124]},"error":{"code":"ok"}}';
  const s = scriptedFetch([{ body: raw }]);
  const r = await c.fetchPublishStatus({ accessToken: 'T' }, 'v_pub_url~1', s);
  assert.equal(s.calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/status/fetch/');
  assert.deepEqual(JSON.parse(s.calls[0].options.body), { publish_id: 'v_pub_url~1' });
  assert.equal(r.success, true);
  assert.equal(r.status, 'PUBLISH_COMPLETE');
  assert.deepEqual(r.videoIds, ['7445813391838234123', '7445813391838234124']);
  const none = await c.fetchPublishStatus({ accessToken: 'T' }, 'p', scriptedFetch([{ body: { data: { status: 'PROCESSING_DOWNLOAD' }, error: { code: 'ok' } } }]));
  assert.deepEqual(none.videoIds, []);
});

test('tiktok: fetchPublishStatus reads post ids only from data, structurally', async () => {
  const c = so.connectors.getConnector('tiktok');
  const poll = (body) => c.fetchPublishStatus({ accessToken: 'T' }, 'p', scriptedFetch([{ body }]));
  const tail = ',"error":{"code":"ok"}}';

  // both documented key spellings
  const typo = await poll('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7445813391838234123]}' + tail);
  assert.deepEqual(typo.videoIds, ['7445813391838234123']);
  const proper = await poll('{"data":{"status":"PUBLISH_COMPLETE","publicly_available_post_id":[7445813391838234124]}' + tail);
  assert.deepEqual(proper.videoIds, ['7445813391838234124']);

  // the same key outside data is ignored, wherever it sits
  const elsewhere = await poll('{"meta":{"publicaly_available_post_id":[987]},"publicly_available_post_id":[654],"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7445813391838234123]}' + tail);
  assert.deepEqual(elsewhere.videoIds, ['7445813391838234123']);
  const onlyElsewhere = await poll('{"extra":{"publicaly_available_post_id":[987]},"data":{"status":"PROCESSING_UPLOAD"}' + tail);
  assert.deepEqual(onlyElsewhere.videoIds, []);

  // a 19-digit run inside a string elsewhere is not a number token and not an id
  const inString = await poll('{"data":{"status":"PROCESSING_UPLOAD","fail_reason":"see \\" 7445813391838234999 \\" ","note":"7445813391838234999"}' + tail);
  assert.equal(inString.success, true);
  assert.deepEqual(inString.videoIds, []);
  assert.equal(inString.raw.data.note, '7445813391838234999');
  assert.equal(inString.raw.data.fail_reason, 'see \" 7445813391838234999 \" ');

  // mixed / invalid elements: keep digit strings and positive safe integers only
  const mixed = await poll('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7445813391838234123,"7445813391838234124",42,"abc","12x",-5,0,1.5,true,null,{"a":1},[2],"",9007199254740993123456789]}' + tail);
  assert.deepEqual(mixed.videoIds, ['7445813391838234123', '7445813391838234124', '42', '9007199254740993123456789']);
  const notList = await poll('{"data":{"publicaly_available_post_id":7445813391838234123}' + tail);
  assert.deepEqual(notList.videoIds, []);
  const dataIsArray = await poll('{"data":[{"publicaly_available_post_id":[7445813391838234123]}]' + tail);
  assert.deepEqual(dataIsArray.videoIds, []);

  // non-JSON or truncated bodies never yield ids
  for (const body of ['<html>"publicaly_available_post_id":[987]</html>', '{"data":{"publicaly_available_post_id":[7445813391838234123]', '']) {
    const r = await poll(body);
    assert.equal(r.success, false, body);
    assert.equal(r.error, 'TikTok status: unreadable response');
    assert.deepEqual([r.kind, r.retryable], ['server', true]);
    assert.equal(r.videoIds, undefined);
  }

  // an error envelope is a failure with local text, even on HTTP 200
  const denied = await poll({ error: { code: 'access_token_invalid', message: 'Bearer SECRET' } });
  assert.deepEqual([denied.success, denied.kind, denied.error], [false, 'auth', 'TikTok status 200: access_token_invalid']);
  const http500 = await c.fetchPublishStatus({ accessToken: 'T' }, 'p', scriptedFetch([{ ok: false, status: 500, body: '<html>boom</html>' }]));
  assert.deepEqual([http500.kind, http500.retryable, http500.error], ['server', true, 'TikTok status 500: unrecognized_error']);
});

test('oauth: tiktok capability scopes match the scopes requested at authorize', () => {
  const tt = new URL(so.oauth.buildAuthorizeUrl('tiktok', { clientId: 'k', redirectUri: 'https://cuddler.ai/cb' }).url);
  assert.deepEqual([...so.capabilities.getPlatform('tiktok').auth.scopes], tt.searchParams.get('scope').split(','));
});

test('tiktok: publish always sends both brand toggles as booleans; validate allows branded only when public or friends', async () => {
  const c = so.connectors.getConnector('tiktok');
  const base = { text: 'cap', videoUrl: 'https://x/v.mp4' };
  const s = scriptedFetch([{ body: { data: { publish_id: 'p1' }, error: { code: 'ok' } } }]);
  await c.publish({ accessToken: 'T' }, base, s);
  const info = JSON.parse(s.calls[0].options.body).post_info;
  assert.equal(info.brand_content_toggle, false);
  assert.equal(info.brand_organic_toggle, false);
  const s2 = scriptedFetch([{ body: { data: { publish_id: 'p2' }, error: { code: 'ok' } } }]);
  await c.publish({ accessToken: 'T' }, { ...base, privacyLevel: 'PUBLIC_TO_EVERYONE', brandContentToggle: true, brandOrganicToggle: true }, s2);
  const info2 = JSON.parse(s2.calls[0].options.body).post_info;
  assert.equal(info2.brand_content_toggle, true);
  assert.equal(info2.brand_organic_toggle, true);
  assert.equal(info2.privacy_level, 'PUBLIC_TO_EVERYONE');
  // truthy non-booleans do not count as true
  const s3 = scriptedFetch([{ body: { data: { publish_id: 'p3' }, error: { code: 'ok' } } }]);
  await c.publish({ accessToken: 'T' }, { ...base, brandContentToggle: 'yes' }, s3);
  assert.equal(JSON.parse(s3.calls[0].options.body).post_info.brand_content_toggle, false);

  assert.match(c.validate({ ...base, brandContentToggle: true }).join(), /branded content must be public or friends-only/); // defaulted SELF_ONLY
  for (const privacyLevel of ['SELF_ONLY', 'FOLLOWER_OF_CREATOR']) {
    assert.match(c.validate({ ...base, brandContentToggle: true, privacyLevel }).join(), /branded content must be public or friends-only/, privacyLevel);
  }
  for (const privacyLevel of ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS']) {
    assert.deepEqual(c.validate({ ...base, brandContentToggle: true, privacyLevel }), [], privacyLevel);
  }
  assert.deepEqual(c.validate({ ...base, brandOrganicToggle: true, privacyLevel: 'FOLLOWER_OF_CREATOR' }), [], 'Your brand has no visibility limit');
  assert.deepEqual(c.validate({ ...base, brandOrganicToggle: true }), []);
  const rejected = await c.publish({ accessToken: 'T' }, { ...base, brandContentToggle: true }, noNet);
  assert.equal(rejected.success, false);
  assert.equal(rejected.kind, 'client');
  const followers = await c.publish({ accessToken: 'T' }, { ...base, brandContentToggle: true, privacyLevel: 'FOLLOWER_OF_CREATOR' }, noNet);
  assert.equal(followers.success, false);
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
  assert.equal(tt.searchParams.get('scope'), 'user.info.basic,video.publish', 'only scopes the TikTok app has enabled');
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

const IG_EXCHANGE = { clientId: 'cid', clientSecret: 'CLIENT-SECRET-1', code: 'AUTH-CODE-1', redirectUri: 'https://cuddler.ai/cb' };
const igTokenSteps = () => [
  { body: { access_token: 'SHORT-TOKEN-1', token_type: 'bearer' } },
  { body: { access_token: 'LONG-TOKEN-1', expires_in: 5183944 } },
];
function assertNoSecrets(issue) {
  const s = JSON.stringify(issue);
  for (const bad of ['SHORT-TOKEN-1', 'LONG-TOKEN-1', 'CLIENT-SECRET-1', 'AUTH-CODE-1', 'SECRET', 'access_token', '://']) {
    assert.ok(!s.includes(bad), `identityIssue leaked ${bad}: ${s}`);
  }
}

test('oauth: instagram authorize scope requests business_management alongside the existing permissions', () => {
  const ig = new URL(so.oauth.buildAuthorizeUrl('instagram', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url);
  const scopes = ig.searchParams.get('scope').split(',');
  for (const want of ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management']) {
    assert.ok(scopes.includes(want), `missing ${want} in ${scopes}`);
  }
});

test('oauth: instagram /me/accounts failure surfaces a graphError identityIssue', async () => {
  const msg = '(#200) The permission is not granted';
  const s = scriptedFetch([
    ...igTokenSteps(),
    { ok: false, status: 400, body: { error: { message: msg, type: 'OAuthException', code: 200, error_subcode: 123 } } },
  ]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.equal(ex.account.id, null);
  assert.deepEqual(ex.identityIssue, {
    reason: 'pages_request_failed',
    httpStatus: 400,
    graphError: { code: 200, subcode: 123, type: 'OAuthException', message: msg, messageWithheld: false },
    pageCount: null,
    morePages: null,
    errorName: null,
  });
  assertNoSecrets(ex.identityIssue);
});

test('oauth: instagram /me/accounts failure with a non-Graph body is invalid_pages_response, a partial Graph error keeps missing fields null', async () => {
  const html = scriptedFetch([...igTokenSteps(), { ok: false, status: 502, body: '<html>bad gateway</html>' }]);
  const a = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, html);
  assert.deepEqual(a.identityIssue, { reason: 'invalid_pages_response', httpStatus: 502, graphError: null, pageCount: null, morePages: null, errorName: null });
  const partial = scriptedFetch([...igTokenSteps(), { ok: false, status: 403, body: { error: { code: 4, message: 'nope' } } }]);
  const b = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, partial);
  assert.deepEqual(b.identityIssue.graphError, { code: 4, subcode: null, type: null, message: 'nope', messageWithheld: false });
});

test('oauth: instagram with no pages reports no_pages', async () => {
  const s = scriptedFetch([...igTokenSteps(), { body: { data: [] } }]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.equal(ex.account.id, null);
  assert.deepEqual(ex.identityIssue, { reason: 'no_pages', httpStatus: 200, graphError: null, pageCount: 0, morePages: false, errorName: null });
  assertNoSecrets(ex.identityIssue);
});

test('oauth: instagram pages without a linked instagram account report no_linked_instagram', async () => {
  const s = scriptedFetch([
    ...igTokenSteps(),
    { body: { data: [{ id: 'pg-1', name: 'A', access_token: 'PAGE-TOKEN-1' }, { id: 'pg-2', name: 'B', access_token: 'PAGE-TOKEN-2' }] } },
  ]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.equal(ex.account.id, null);
  assert.deepEqual(ex.identityIssue, { reason: 'no_linked_instagram', httpStatus: 200, graphError: null, pageCount: 2, morePages: false, errorName: null });
  assertNoSecrets(ex.identityIssue);
});

test('oauth: instagram lookup that throws reports lookup_failed with the error name only', async () => {
  const steps = igTokenSteps();
  let n = 0;
  const base = scriptedFetch([...steps]);
  const fetch = async (url, options) => {
    n += 1;
    if (n === 3) throw new TypeError(`fetch failed: ${url}&access_token=SECRET`);
    return base.fetch(url, options);
  };
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, { fetch });
  assert.equal(ex.account.id, null);
  assert.deepEqual(ex.identityIssue, { reason: 'lookup_failed', httpStatus: null, graphError: null, pageCount: null, morePages: null, errorName: 'TypeError' });
  assertNoSecrets(ex.identityIssue);
});

const LONG_TOKEN_LIKE = 'EAABwzLixnjYBO0ZCvYtT3kQ9ZAfXqB1m8dXyZpL0aV7sWc';
const igGraph400 = (error) => [...igTokenSteps(), { ok: false, status: 400, body: { error } }];

test('oauth: instagram graphError withholds a message that could carry a credential and keeps the numbers', async () => {
  const leaks = [
    `(#190) Invalid OAuth access token ${LONG_TOKEN_LIKE}`,
    '(#190) Request failed https://graph.facebook.com/v26.0/me/accounts?access_token=abc',
    '(#190) Bad token LONG-TOKEN-1 given',
    '(#190) Bad secret CLIENT-SECRET-1 given',
    '(#190) Bad token SHORT-TOKEN-1 given',
    '(#190) Bearer abc rejected',
    '(#190) mail me at ops@example.com',
    '(#190) a=b',
    `(#190) ${'x'.repeat(301)}`,
    '(#190) line\nbreak',
  ];
  for (const message of leaks) {
    const s = scriptedFetch(igGraph400({ message, type: 'OAuthException', code: 190, error_subcode: 463 }));
    const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
    assert.equal(ex.identityIssue.reason, 'pages_request_failed', message);
    assert.deepEqual(ex.identityIssue.graphError, { code: 190, subcode: 463, type: 'OAuthException', message: null, messageWithheld: true }, message);
    assertNoSecrets(ex.identityIssue);
    assert.ok(!JSON.stringify(ex.identityIssue).includes(LONG_TOKEN_LIKE));
  }
});

test('oauth: instagram graphError keeps a benign Graph message verbatim', async () => {
  const message = '(#200) Requires business_management permission to manage the object';
  const s = scriptedFetch(igGraph400({ message, type: 'OAuthException', code: 200 }));
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.deepEqual(ex.identityIssue, {
    reason: 'pages_request_failed',
    httpStatus: 400,
    graphError: { code: 200, subcode: null, type: 'OAuthException', message, messageWithheld: false },
    pageCount: null,
    morePages: null,
    errorName: null,
  });
});

test('oauth: instagram graphError messageWithheld is false when there is no message', async () => {
  const s = scriptedFetch(igGraph400({ code: 4 }));
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.deepEqual(ex.identityIssue.graphError, { code: 4, subcode: null, type: null, message: null, messageWithheld: false });
});

test('oauth: instagram graphError drops non-integer codes and types that are not an Exception class name', async () => {
  const badSubcode = scriptedFetch(igGraph400({ message: 'ok text', code: 1, error_subcode: { token: LONG_TOKEN_LIKE }, type: 'Bad Type' }));
  const a = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, badSubcode);
  assert.deepEqual(a.identityIssue.graphError, { code: 1, subcode: null, type: null, message: 'ok text', messageWithheld: false });
  assert.ok(!JSON.stringify(a.identityIssue).includes(LONG_TOKEN_LIKE));
  const tokenType = scriptedFetch(igGraph400({ code: 190, error_subcode: 1.5, type: `EAAB${LONG_TOKEN_LIKE}` }));
  const b = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, tokenType);
  assert.deepEqual(b.identityIssue.graphError, { code: 190, subcode: null, type: null, message: null, messageWithheld: false });
  assert.ok(!JSON.stringify(b.identityIssue).includes(LONG_TOKEN_LIKE));
  for (const type of ['GraphMethodException', 'IGApiException', 'OAuthException']) {
    const s = scriptedFetch(igGraph400({ code: 1, type }));
    assert.equal((await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s)).identityIssue.graphError.type, type);
  }
});

test('oauth: instagram non-ok bodies that are not a Graph error report invalid_pages_response', async () => {
  const bodies = ['<html>forbidden</html>', '', {}, { error: 'denied' }, { error: {} }, { error: { code: 'x' } }, { error: [1] }, null, { error: { message: 'Forbidden' } }, { error: { message: '' } }, { error: { message: LONG_TOKEN_LIKE, code: LONG_TOKEN_LIKE } }];
  for (const body of bodies) {
    const s = scriptedFetch([...igTokenSteps(), { ok: false, status: 403, body }]);
    const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
    assert.deepEqual(ex.identityIssue, { reason: 'invalid_pages_response', httpStatus: 403, graphError: null, pageCount: null, morePages: null, errorName: null }, JSON.stringify(body));
  }
});

test('oauth: instagram a generic message-only 403 body is not a Graph error', async () => {
  const s = scriptedFetch([...igTokenSteps(), { ok: false, status: 403, body: { error: { message: 'Forbidden' } } }]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.deepEqual(ex.identityIssue, { reason: 'invalid_pages_response', httpStatus: 403, graphError: null, pageCount: null, morePages: null, errorName: null });
});

test('oauth: instagram message length and control characters are judged before trimming', async () => {
  const cases = [
    '\n(#200) Requires permission',
    '(#200) Requires permission\t',
    ' \n ',
    `(#200) Requires permission${' '.repeat(300)}`,
  ];
  for (const message of cases) {
    const s = scriptedFetch(igGraph400({ message, type: 'OAuthException', code: 200 }));
    const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
    assert.deepEqual(ex.identityIssue.graphError, { code: 200, subcode: null, type: 'OAuthException', message: null, messageWithheld: true }, JSON.stringify(message));
  }
  const padded = scriptedFetch(igGraph400({ message: '  (#200) Requires permission  ', code: 200 }));
  assert.equal((await so.oauth.exchangeCode('instagram', IG_EXCHANGE, padded)).identityIssue.graphError.message, '(#200) Requires permission');
  const empty = scriptedFetch(igGraph400({ message: '', code: 200 }));
  assert.deepEqual((await so.oauth.exchangeCode('instagram', IG_EXCHANGE, empty)).identityIssue.graphError, { code: 200, subcode: null, type: null, message: null, messageWithheld: false });
});

test('oauth: instagram httpStatus is kept only inside 100..599', async () => {
  for (const [status, want] of [[599, 599], [100, 100]]) {
    const s = scriptedFetch([...igTokenSteps(), { ok: false, status, body: '<html/>' }]);
    assert.equal((await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s)).identityIssue.httpStatus, want);
  }
  const odd = scriptedFetch([...igTokenSteps(), { ok: false, status: LONG_TOKEN_LIKE, body: '<html/>' }]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, odd);
  assert.equal(ex.identityIssue.httpStatus, null);
});

test('oauth: instagram ok responses that are not a pages list report invalid_pages_response', async () => {
  for (const body of ['<html>ok</html>', {}, { data: 'x' }, { data: { id: '1' } }, [], null, { data: ['x', 3, null, []] }]) {
    const s = scriptedFetch([...igTokenSteps(), { body }]);
    const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
    assert.equal(ex.account.id, null);
    assert.deepEqual(ex.identityIssue, { reason: 'invalid_pages_response', httpStatus: 200, graphError: null, pageCount: null, morePages: null, errorName: null }, JSON.stringify(body));
  }
});

test('oauth: instagram reports morePages when the first page has paging.next and only counts page objects', async () => {
  const withNext = scriptedFetch([...igTokenSteps(), { body: { data: [{ id: '1', name: 'P' }, 'junk'], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts?after=x' } } }]);
  const a = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, withNext);
  assert.deepEqual(a.identityIssue, { reason: 'no_linked_instagram', httpStatus: 200, graphError: null, pageCount: 1, morePages: true, errorName: null });
  assertNoSecrets({ ...a.identityIssue, morePages: undefined });
  const without = scriptedFetch([...igTokenSteps(), { body: { data: [{ id: '1', name: 'P' }] } }]);
  const b = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, without);
  assert.deepEqual(b.identityIssue, { reason: 'no_linked_instagram', httpStatus: 200, graphError: null, pageCount: 1, morePages: false, errorName: null });
  assert.equal(withNext.calls.length, 3, 'does not follow pagination');
});

test('oauth: instagram thrown error names are limited to an allowlist', async () => {
  const throwing = (make) => {
    let n = 0;
    const base = scriptedFetch(igTokenSteps());
    return { fetch: async (url, options) => { n += 1; if (n === 3) throw make(); return base.fetch(url, options); } };
  };
  const named = (name) => () => Object.assign(new Error(`failed with ${LONG_TOKEN_LIKE}`), { name });
  const evil = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, throwing(named(LONG_TOKEN_LIKE)));
  assert.equal(evil.identityIssue.errorName, 'Error');
  assert.ok(!JSON.stringify(evil.identityIssue).includes(LONG_TOKEN_LIKE));
  const notString = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, throwing(() => ({ name: { a: 1 } })));
  assert.equal(notString.identityIssue.errorName, 'Error');
  const type = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, throwing(() => new TypeError('x')));
  assert.equal(type.identityIssue.errorName, 'TypeError');
  const abort = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, throwing(named('AbortError')));
  assert.equal(abort.identityIssue.errorName, 'AbortError');
});

test('oauth: instagram capability scopes match the scopes requested at authorize', () => {
  const requested = new URL(so.oauth.buildAuthorizeUrl('instagram', { clientId: 'c', redirectUri: 'https://cuddler.ai/cb' }).url).searchParams.get('scope').split(',');
  assert.deepEqual([...so.capabilities.getPlatform('instagram').auth.scopes].sort(), [...requested].sort());
});

test('oauth: instagram linked page resolves the account and leaves identityIssue absent', async () => {
  const s = scriptedFetch([
    ...igTokenSteps(),
    { body: { data: [{ id: 'pg-1', name: 'Cuddler', access_token: 'PAGE-TOKEN-1', instagram_business_account: { id: 'ig-9' } }] } },
    { body: { username: 'cuddlerai' } },
  ]);
  const ex = await so.oauth.exchangeCode('instagram', IG_EXCHANGE, s);
  assert.equal(ex.account.id, 'ig-9');
  assert.equal(ex.accessToken, 'PAGE-TOKEN-1');
  assert.equal('identityIssue' in ex, false);
});

test('oauth: non-instagram exchanges never carry identityIssue', async () => {
  const s = scriptedFetch([{ body: { access_token: 'AT', refresh_token: 'RT', expires_in: 7200 } }, { body: { data: { id: 'u1', username: 'me' } } }]);
  const ex = await so.oauth.exchangeCode('x', { clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'https://cuddler.ai/cb', codeVerifier: 'v' }, s);
  assert.equal('identityIssue' in ex, false);
});
