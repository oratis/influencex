const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let lastApifyCall;
function loadModule({ apifyResult, configured = true } = {}) {
  delete require.cache[require.resolve('../x-discovery')];
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../apify-quota')];
  require.cache[require.resolve('../apify-client')] = {
    exports: {
      isConfigured: () => configured,
      runActor: async (actorId, input, opts) => {
        lastApifyCall = { actorId, input, opts };
        return apifyResult || { success: true, items: [] };
      },
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
  return require('../x-discovery');
}

beforeEach(() => { lastApifyCall = null; });

test('searchXKeyword: rejects when Apify not configured', async () => {
  const m = loadModule({ configured: false });
  const r = await m.searchXKeyword({ keywords: 'foo' });
  assert.equal(r.success, false);
  assert.match(r.error, /not configured/i);
});

test('searchXKeyword: aggregates authors from tweets', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { author: { userName: 'alice', name: 'Alice', followers: 5000 } },
        { author: { userName: 'alice', name: 'Alice', followers: 5000 } },
        { author: { userName: 'bob', name: 'Bob', followers: 12000, isVerified: true } },
      ],
    },
  });
  const r = await m.searchXKeyword({ keywords: 'gaming', minSubscribers: 1000 });
  assert.equal(r.success, true);
  assert.equal(r.creators.length, 2);
  // Bob is verified + has more followers → higher score
  assert.equal(r.creators[0].username, 'bob');
});

test('searchXKeyword: filters out below minSubscribers', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { author: { userName: 'tiny', followers: 10 } },
        { author: { userName: 'big', followers: 5000 } },
      ],
    },
  });
  const r = await m.searchXKeyword({ keywords: 'foo', minSubscribers: 1000 });
  assert.equal(r.creators.length, 1);
  assert.equal(r.creators[0].username, 'big');
});

test('keywordToQueries: caps at 5 queries', () => {
  const m = loadModule();
  const q = m.keywordToQueries('a, b, c, d, e, f, g');
  assert.equal(q.length, 5);
});

test('scoreCreator: verified bumps score', () => {
  const m = loadModule();
  const a = m.scoreCreator({ posts: 1, followers: 5000, verified: false });
  const b = m.scoreCreator({ posts: 1, followers: 5000, verified: true });
  assert.ok(b > a);
});
