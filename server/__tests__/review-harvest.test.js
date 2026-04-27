const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadModule({ apifyResult, configured = true } = {}) {
  delete require.cache[require.resolve('../review-harvest')];
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
      canCall: () => ({ allowed: true, reason: null, runs: 0, items: 0, runLimit: 100, itemsLimit: 1000 }),
      record: () => ({ runs: 1, items: 0 }),
    },
    loaded: true,
    id: require.resolve('../apify-quota'),
    filename: require.resolve('../apify-quota'),
    children: [],
    parent: null,
  };
  return require('../review-harvest');
}

test('quickSentiment: positive heavy text', () => {
  const m = loadModule();
  const r = m.quickSentiment('I love this game, it is amazing and addictive!');
  assert.equal(r.label, 'positive');
  assert.ok(r.score > 0);
});

test('quickSentiment: negative heavy text', () => {
  const m = loadModule();
  const r = m.quickSentiment('This is broken and a waste of money. Terrible.');
  assert.equal(r.label, 'negative');
  assert.ok(r.score < 0);
});

test('quickSentiment: neutral / empty', () => {
  const m = loadModule();
  assert.equal(m.quickSentiment('').label, 'neutral');
  assert.equal(m.quickSentiment('It is a game.').label, 'neutral');
});

test('normalizeSteamReview: extracts rating from voted_up', () => {
  const m = loadModule();
  const out = m.normalizeSteamReview({
    recommendationid: 'r1',
    review: 'amazing game',
    voted_up: true,
    votes_up: 10,
    timestamp_created: 1700000000,
    author: { steamid: 's1', persona_name: 'Player' },
  });
  assert.equal(out.platform, 'steam');
  assert.equal(out.rating, 5);
  assert.equal(out.helpful_count, 10);
  assert.equal(out.sentiment.label, 'positive');
});

test('normalizeAppStoreReview: extracts rating', () => {
  const m = loadModule();
  const out = m.normalizeAppStoreReview({
    id: 'a1', review: 'great app', rating: 5, userName: 'tester', date: '2026-01-01',
  });
  assert.equal(out.rating, 5);
  assert.equal(out.platform, 'app-store');
});

test('normalizePlayStoreReview: extracts thumbsUpCount', () => {
  const m = loadModule();
  const out = m.normalizePlayStoreReview({
    reviewId: 'p1', text: 'fun', score: 4, userName: 'u', thumbsUpCount: 7, at: '2026-01-01',
  });
  assert.equal(out.helpful_count, 7);
});

test('summarize: counts pos/neu/neg + avg rating', () => {
  const m = loadModule();
  const reviews = [
    { sentiment: { label: 'positive', score: 0.8 }, rating: 5 },
    { sentiment: { label: 'positive', score: 0.5 }, rating: 4 },
    { sentiment: { label: 'negative', score: -0.7 }, rating: 1 },
    { sentiment: { label: 'neutral', score: 0 }, rating: 3 },
  ];
  const s = m.summarize(reviews);
  assert.equal(s.total, 4);
  assert.equal(s.positive, 2);
  assert.equal(s.negative, 1);
  assert.equal(s.neutral, 1);
  assert.equal(s.positive_pct, 50);
  assert.equal(s.avg_rating, 13 / 4);
});

test('harvestSteamReviews: rejects without appId', async () => {
  const m = loadModule();
  const r = await m.harvestSteamReviews({});
  assert.equal(r.success, false);
});

test('harvestSteamReviews: returns reviews + summary', async () => {
  const m = loadModule({
    apifyResult: {
      success: true,
      items: [
        { recommendationid: '1', review: 'amazing fun', voted_up: true, timestamp_created: 1700000000 },
        { recommendationid: '2', review: 'broken bug', voted_up: false, timestamp_created: 1700000001 },
      ],
    },
  });
  const r = await m.harvestSteamReviews({ appId: '12345' });
  assert.equal(r.success, true);
  assert.equal(r.reviews.length, 2);
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.positive, 1);
  assert.equal(r.summary.negative, 1);
});

test('harvestPlayStoreReviews: rejects when not configured', async () => {
  const m = loadModule({ configured: false });
  const r = await m.harvestPlayStoreReviews({ appId: 'com.x' });
  assert.equal(r.success, false);
});
