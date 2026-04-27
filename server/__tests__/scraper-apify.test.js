const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Verifies that scraper.js uses Apify as a fallback when MODASH_API_KEY is not
// set, that it passes workspaceId through, and that quota gating is honored.

function loadScraper({ apifyConfigured = true, igResult, tiktokResult, modashKey } = {}) {
  // Reset module cache for deterministic test runs.
  delete require.cache[require.resolve('../scraper')];
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../apify-quota')];

  // Stub apify-client.
  require.cache[require.resolve('../apify-client')] = {
    exports: {
      isConfigured: () => apifyConfigured,
      scrapeInstagram: async (username, opts) => igResult || { success: false, error: 'stub' },
      scrapeTikTok: async (url, opts) => tiktokResult || { success: false, error: 'stub' },
      runActor: async () => ({ success: false }),
    },
    loaded: true,
    id: require.resolve('../apify-client'),
    filename: require.resolve('../apify-client'),
    children: [],
    parent: null,
  };

  // Stub apify-quota — always allow by default.
  let lastRecord = null;
  const quotaStub = {
    canCall: (actor, items, wsId) => ({ allowed: true, runs: 0, items: 0, runLimit: 100, itemsLimit: 1000, runRemaining: 100, itemsRemaining: 1000, reason: null }),
    record: (actor, items, wsId) => { lastRecord = { actor, items, wsId }; return { runs: 1, items }; },
    status: () => ({}),
  };
  require.cache[require.resolve('../apify-quota')] = {
    exports: quotaStub,
    loaded: true,
    id: require.resolve('../apify-quota'),
    filename: require.resolve('../apify-quota'),
    children: [],
    parent: null,
  };

  if (modashKey) process.env.MODASH_API_KEY = modashKey;
  else delete process.env.MODASH_API_KEY;

  const scraper = require('../scraper');
  return { scraper, getLastRecord: () => lastRecord };
}

beforeEach(() => {
  delete process.env.MODASH_API_KEY;
});

test('scrapeInstagram: uses Apify when configured and no Modash', async () => {
  const { scraper, getLastRecord } = loadScraper({
    apifyConfigured: true,
    igResult: {
      success: true,
      username: 'foo',
      display_name: 'Foo Bar',
      avatar_url: 'http://example.com/a.jpg',
      followers: 12345,
      following: 100,
      total_videos: 50,
      bio: 'hello',
      verified: true,
      email: null,
    },
  });
  const r = await scraper.scrapeInstagram('https://instagram.com/foo', 'foo', { workspaceId: 'ws-9' });
  assert.equal(r.success, true);
  assert.equal(r.source, 'apify');
  assert.equal(r.data.followers, 12345);
  assert.equal(r.data.display_name, 'Foo Bar');
  // Quota record was called with the workspace id.
  const rec = getLastRecord();
  assert.equal(rec.wsId, 'ws-9');
});

test('scrapeInstagram: returns error when Apify not configured + no Modash', async () => {
  const { scraper } = loadScraper({ apifyConfigured: false });
  const r = await scraper.scrapeInstagram('https://instagram.com/foo', 'foo');
  assert.equal(r.success, false);
  assert.match(r.error, /MODASH_API_KEY or APIFY_TOKEN/i);
});

test('scrapeInstagram: falls back to error when Apify fails', async () => {
  const { scraper } = loadScraper({
    apifyConfigured: true,
    igResult: { success: false, error: 'apify timeout' },
  });
  const r = await scraper.scrapeInstagram('https://instagram.com/foo', 'foo');
  assert.equal(r.success, false);
  assert.match(r.error, /apify/i);
});

test('scrapeTikTok: uses Apify before HTML fallback', async () => {
  const { scraper, getLastRecord } = loadScraper({
    apifyConfigured: true,
    tiktokResult: {
      success: true,
      username: 'tt',
      display_name: 'TT',
      avatar_url: '',
      followers: 9999,
      following: 5,
      total_videos: 12,
      bio: '',
      verified: false,
      email: null,
    },
  });
  const r = await scraper.scrapeTikTok('https://www.tiktok.com/@tt', 'tt', { workspaceId: 'ws-77' });
  assert.equal(r.success, true);
  assert.equal(r.source, 'apify');
  assert.equal(r.data.followers, 9999);
  const rec = getLastRecord();
  assert.equal(rec.wsId, 'ws-77');
});
