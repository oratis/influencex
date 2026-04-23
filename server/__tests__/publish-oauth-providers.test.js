/**
 * Coverage for the TikTok / Threads / Facebook / Pinterest / Reddit OAuth
 * providers. We verify registry shape, authorize-URL composition (including
 * TikTok's client_key quirk and Reddit's duration=permanent), and that each
 * publishDirect path returns a clear input-validation error without a token,
 * so we don't have to stub every upstream API in tests.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const publishOauth = require('../publish/oauth');

const ENV_KEYS = [
  'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET',
  'THREADS_APP_ID', 'THREADS_APP_SECRET',
  'META_APP_ID', 'META_APP_SECRET',
  'PINTEREST_APP_ID', 'PINTEREST_APP_SECRET',
  'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET',
];
const saved = {};
before(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = `test-${k}`; }
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('all 5 new providers are registered with oauth kind', () => {
  for (const id of ['tiktok', 'threads', 'facebook', 'pinterest', 'reddit']) {
    const p = publishOauth.getProvider(id);
    assert.ok(p, `${id} provider missing`);
    assert.equal(p.kind, 'oauth');
  }
});

test('listProviders surfaces all new providers as configured', () => {
  const ids = publishOauth.listProviders().filter(p => p.configured).map(p => p.id);
  for (const id of ['tiktok', 'threads', 'facebook', 'pinterest', 'reddit']) {
    assert.ok(ids.includes(id), `${id} not reported configured`);
  }
});

test('tiktok authorize URL uses client_key (not client_id) and PKCE', () => {
  const { url, codeVerifier } = publishOauth.buildAuthorizeUrl('tiktok', { workspaceId: 'w', userId: 'u' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_key'), 'test-TIKTOK_CLIENT_KEY');
  assert.equal(parsed.searchParams.get('client_id'), null, 'TikTok should NOT send client_id');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(codeVerifier);
  assert.ok(parsed.searchParams.get('scope').includes('video.publish'));
});

test('reddit authorize URL includes duration=permanent (for refresh_token)', () => {
  const { url } = publishOauth.buildAuthorizeUrl('reddit', { workspaceId: 'w', userId: 'u' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('duration'), 'permanent');
  assert.equal(parsed.searchParams.get('client_id'), 'test-REDDIT_CLIENT_ID');
  assert.ok(parsed.searchParams.get('scope').includes('submit'));
});

test('pinterest + threads + facebook authorize URLs carry required scopes', () => {
  const pin = publishOauth.buildAuthorizeUrl('pinterest', { workspaceId: 'w', userId: 'u' });
  assert.ok(new URL(pin.url).searchParams.get('scope').includes('pins:write'));

  const th = publishOauth.buildAuthorizeUrl('threads', { workspaceId: 'w', userId: 'u' });
  assert.ok(new URL(th.url).searchParams.get('scope').includes('threads_content_publish'));

  const fb = publishOauth.buildAuthorizeUrl('facebook', { workspaceId: 'w', userId: 'u' });
  assert.ok(new URL(fb.url).searchParams.get('scope').includes('pages_manage_posts'));
});

test('publishDirect tiktok requires video_url', async () => {
  const r = await publishOauth.publishDirect('tiktok', 'fake-token', { text: 'hi' });
  assert.equal(r.success, false);
  assert.match(r.error, /video_url/i);
});

test('publishDirect pinterest requires board_id and image_url', async () => {
  const noBoard = await publishOauth.publishDirect('pinterest', 'fake-token', { text: 'hi', imageUrl: 'https://x.test/i.jpg' });
  assert.equal(noBoard.success, false);
  assert.match(noBoard.error, /board_id/i);

  const noImg = await publishOauth.publishDirect('pinterest', 'fake-token', { text: 'hi', board_id: 'b1' });
  assert.equal(noImg.success, false);
  assert.match(noImg.error, /image_url/i);
});

test('publishDirect reddit requires subreddit + title', async () => {
  const noSub = await publishOauth.publishDirect('reddit', 'fake-token', { text: 'hi', title: 'Hello' });
  assert.equal(noSub.success, false);
  assert.match(noSub.error, /subreddit/i);

  const noTitle = await publishOauth.publishDirect('reddit', 'fake-token', { text: 'hi', subreddit: 'test' });
  assert.equal(noTitle.success, false);
  assert.match(noTitle.error, /title/i);
});

test('publishDirect threads requires user id (via accountId)', async () => {
  // accountId is injected from platform_connections.account_id; missing it means
  // the connection wasn't completed properly.
  const r = await publishOauth.publishDirect('threads', 'fake-token', { text: 'hi' });
  assert.equal(r.success, false);
  assert.match(r.error, /user id/i);
});

test('publishDirect facebook requires page id (via accountId)', async () => {
  const r = await publishOauth.publishDirect('facebook', 'fake-token', { text: 'hi' });
  assert.equal(r.success, false);
  assert.match(r.error, /page_id/i);
});

test('threads post refuses empty content', async () => {
  const r = await publishOauth.publishDirect('threads', 'fake-token', { accountId: 'threads-user-1' });
  assert.equal(r.success, false);
  assert.match(r.error, /text or image_url/i);
});
