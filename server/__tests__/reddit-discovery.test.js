const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function loadModule({ apifyResult, configured = true } = {}) {
  delete require.cache[require.resolve('../reddit-discovery')];
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
      canCall: () => ({ allowed: true, runs: 0, items: 0, runLimit: 100, itemsLimit: 1000, runRemaining: 100, itemsRemaining: 1000, reason: null }),
      record: () => ({ runs: 1, items: 0 }),
    },
    loaded: true,
    id: require.resolve('../apify-quota'),
    filename: require.resolve('../apify-quota'),
    children: [],
    parent: null,
  };
  return require('../reddit-discovery');
}

test('searchRedditKeyword: rejects when Apify not configured', async () => {
  const m = loadModule({ configured: false });
  const r = await m.searchRedditKeyword({ keywords: 'foo' });
  assert.equal(r.success, false);
});

test('searchRedditKeyword: aggregates authors from posts', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { author: 'alice', authorKarma: 5000 },
        { author: 'alice', authorKarma: 5000 },
        { author: 'bob', authorKarma: 12000, gilded: true },
      ],
    },
  });
  const r = await m.searchRedditKeyword({ keywords: 'gaming', minSubscribers: 1000 });
  assert.equal(r.success, true);
  assert.equal(r.creators.length, 2);
  assert.equal(r.creators[0].username, 'bob');
});

test('searchRedditKeyword: filters [deleted] authors', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { author: '[deleted]', authorKarma: 1000 },
        { author: 'real', authorKarma: 1000 },
      ],
    },
  });
  const r = await m.searchRedditKeyword({ keywords: 'foo', minSubscribers: 100 });
  assert.equal(r.creators.length, 1);
  assert.equal(r.creators[0].username, 'real');
});

test('keywordToSubreddits: trims + caps at 5', () => {
  const m = loadModule();
  const s = m.keywordToSubreddits('  a , b ,c, d, e, f, g');
  assert.equal(s.length, 5);
  assert.equal(s[0], 'a');
});
