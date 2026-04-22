const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Replace proxy-fetch in the require cache with a controllable stub BEFORE
// oauth.js is required. The stub records every call and returns whatever the
// current test has queued.
const proxyFetchPath = require.resolve('../proxy-fetch');
let queued = [];
let calls = [];
require.cache[proxyFetchPath] = {
  id: proxyFetchPath,
  filename: proxyFetchPath,
  loaded: true,
  exports: async (url, options) => {
    calls.push({ url, options });
    const next = queued.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body || ''),
    };
  },
};

const oauth = require('../publish/oauth');

function resetMocks() { queued = []; calls = []; }

test('publishDirect(instagram) runs 2-step container→publish flow', async () => {
  resetMocks();
  queued.push({ body: { id: 'creation-123' } });       // POST /media
  queued.push({ body: { id: 'post-999' } });           // POST /media_publish

  const r = await oauth.publishDirect('instagram', 'PAGE_TOKEN', {
    text: 'hello ig',
    imageUrl: 'https://example.com/pic.jpg',
    accountId: 'ig-user-1',
  });

  assert.equal(r.success, true);
  assert.equal(r.platform_post_id, 'post-999');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('/ig-user-1/media'));
  assert.ok(calls[1].url.includes('/ig-user-1/media_publish'));
  // Body should carry image_url + caption + access_token on step 1
  const step1Body = calls[0].options.body.toString();
  assert.ok(step1Body.includes('image_url=https') && step1Body.includes('caption=hello'));
  assert.ok(step1Body.includes('access_token=PAGE_TOKEN'));
  // Step 2 body uses the creation_id from step 1
  const step2Body = calls[1].options.body.toString();
  assert.ok(step2Body.includes('creation_id=creation-123'));
});

test('publishDirect(instagram) fails fast when imageUrl is missing', async () => {
  resetMocks();
  const r = await oauth.publishDirect('instagram', 'TOK', {
    text: 'no image',
    accountId: 'ig-1',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /image_url/);
  assert.equal(calls.length, 0);
});

test('publishDirect(instagram) fails fast when accountId (ig_user_id) is missing', async () => {
  resetMocks();
  const r = await oauth.publishDirect('instagram', 'TOK', {
    text: 'x',
    imageUrl: 'https://x/y.jpg',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /ig_user_id/);
  assert.equal(calls.length, 0);
});

test('publishDirect(instagram) surfaces Meta API error text on failure', async () => {
  resetMocks();
  queued.push({ ok: false, status: 400, body: { error: { message: 'Invalid image' } } });
  const r = await oauth.publishDirect('instagram', 'TOK', {
    text: 'x', imageUrl: 'https://x/y.jpg', accountId: 'ig-1',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /Instagram create 400/);
});

test('listProviders() includes instagram entry', () => {
  const list = oauth.listProviders();
  const ig = list.find(p => p.id === 'instagram');
  assert.ok(ig, 'expected instagram in listProviders');
  assert.equal(ig.kind, 'oauth');
  assert.match(ig.scope, /instagram_content_publish/);
});
