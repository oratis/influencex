/**
 * YouTube OAuth provider tests.
 *
 * We don't hit real Google endpoints — we verify the provider registration,
 * authorize-URL composition (scopes, PKCE, access_type=offline / prompt=consent
 * so Google issues a refresh_token), and publishDirect dispatch shape.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const publishOauth = require('../publish/oauth');

let origClientId, origClientSecret;
before(() => {
  origClientId = process.env.YOUTUBE_CLIENT_ID;
  origClientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  process.env.YOUTUBE_CLIENT_ID = 'test-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
});
after(() => {
  if (origClientId === undefined) delete process.env.YOUTUBE_CLIENT_ID;
  else process.env.YOUTUBE_CLIENT_ID = origClientId;
  if (origClientSecret === undefined) delete process.env.YOUTUBE_CLIENT_SECRET;
  else process.env.YOUTUBE_CLIENT_SECRET = origClientSecret;
});

test('youtube provider is registered with required scopes', () => {
  const p = publishOauth.getProvider('youtube');
  assert.ok(p, 'youtube provider missing');
  assert.equal(p.kind, 'oauth');
  assert.ok(p.scope.includes('youtube.upload'), 'upload scope missing');
  assert.ok(p.scope.includes('youtube.readonly'), 'readonly scope missing');
  assert.ok(p.scope.includes('yt-analytics.readonly'), 'analytics scope missing');
  assert.equal(p.usesPKCE, true);
});

test('youtube provider is listed in listProviders', () => {
  const list = publishOauth.listProviders();
  const yt = list.find(p => p.id === 'youtube');
  assert.ok(yt, 'youtube not in listProviders()');
  assert.equal(yt.configured, true);
});

test('isConfigured reflects env vars', () => {
  assert.equal(publishOauth.isConfigured('youtube'), true);
  const prev = process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_ID;
  assert.equal(publishOauth.isConfigured('youtube'), false);
  process.env.YOUTUBE_CLIENT_ID = prev;
});

test('buildAuthorizeUrl includes PKCE + access_type=offline + prompt=consent', () => {
  const { url, state, codeVerifier } = publishOauth.buildAuthorizeUrl('youtube', {
    workspaceId: 'ws-1', userId: 'user-1',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'test-client-id');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsed.searchParams.get('code_challenge'));
  assert.ok(parsed.searchParams.get('scope').includes('youtube.upload'));
  assert.ok(state);
  assert.ok(codeVerifier, 'PKCE verifier missing');
});

test('publishDirect youtube returns a clear error when video_url absent', async () => {
  const r = await publishOauth.publishDirect('youtube', 'fake-token', { text: 'Hi', title: 'T' });
  assert.equal(r.success, false);
  assert.match(r.error, /video_url/i);
});

test('listProviders includes YouTube alongside other OAuth platforms', () => {
  const ids = publishOauth.listProviders().map(p => p.id);
  for (const expected of ['twitter', 'linkedin', 'instagram', 'youtube']) {
    assert.ok(ids.includes(expected), `missing ${expected} in providers list`);
  }
});
