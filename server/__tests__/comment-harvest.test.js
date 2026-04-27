const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadModule({ apifyResult, configured = true } = {}) {
  delete require.cache[require.resolve('../comment-harvest')];
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../apify-quota')];
  require.cache[require.resolve('../apify-client')] = {
    exports: {
      isConfigured: () => configured,
      runActor: async () => apifyResult || { success: true, items: [] },
    },
    loaded: true,
    id: require.resolve('../apify-client'),
    filename: require.resolve('../apify-client'),
    children: [],
    parent: null,
  };
  require.cache[require.resolve('../apify-quota')] = {
    exports: {
      canCall: () => ({ allowed: true, reason: null, runs: 0, items: 0, runLimit: 100, itemsLimit: 1000, runRemaining: 100, itemsRemaining: 1000 }),
      record: () => ({ runs: 1, items: 0 }),
    },
    loaded: true,
    id: require.resolve('../apify-quota'),
    filename: require.resolve('../apify-quota'),
    children: [],
    parent: null,
  };
  return require('../comment-harvest');
}

test('normalizeIgComment: extracts owner + text', () => {
  const m = loadModule();
  const out = m.normalizeIgComment({
    id: 'c1', text: 'cool', ownerUsername: 'alice',
    owner: { full_name: 'Alice X' }, likesCount: 5,
    timestamp: 1700000000000,
  }, 'https://instagram.com/p/abc');
  assert.equal(out.author_handle, 'alice');
  assert.equal(out.author_name, 'Alice X');
  assert.equal(out.body, 'cool');
  assert.equal(out.likes, 5);
});

test('normalizeTtComment: handles unix-seconds timestamps', () => {
  const m = loadModule();
  const out = m.normalizeTtComment({
    cid: 'c1', text: 'lol',
    user: { uniqueId: 'bob', nickname: 'Bob' },
    create_time: 1700000000,
    digg_count: 12,
  }, 'https://tiktok.com/@x/video/y');
  assert.equal(out.author_handle, 'bob');
  assert.equal(out.likes, 12);
  assert.ok(out.created_at);
});

test('harvestInstagramComments: rejects when not configured', async () => {
  const m = loadModule({ configured: false });
  const r = await m.harvestInstagramComments({ postUrls: ['x'] });
  assert.equal(r.success, false);
});

test('harvestInstagramComments: requires postUrls array', async () => {
  const m = loadModule();
  const r = await m.harvestInstagramComments({ postUrls: [] });
  assert.equal(r.success, false);
});

test('harvestInstagramComments: aggregates across posts', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { id: '1', text: 'a', ownerUsername: 'u1' },
        { id: '2', text: 'b', ownerUsername: 'u2' },
      ],
    },
  });
  const r = await m.harvestInstagramComments({ postUrls: ['url1', 'url2'] });
  assert.equal(r.success, true);
  // 2 posts × 2 comments each = 4 normalized items
  assert.equal(r.comments.length, 4);
});

test('harvestTikTokComments: aggregates correctly', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [{ cid: 'c1', text: 'hi', user: { uniqueId: 'foo' }, digg_count: 3 }],
    },
  });
  const r = await m.harvestTikTokComments({ videoUrls: ['vid1'] });
  assert.equal(r.success, true);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].platform, 'tiktok');
});
