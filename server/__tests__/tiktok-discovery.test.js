const { test } = require('node:test');
const assert = require('node:assert/strict');

const { keywordToHashtags, scoreCreator } = require('../tiktok-discovery');

test('keywordToHashtags: identical surface to instagram-discovery', () => {
  assert.deepEqual(keywordToHashtags('cooking, dance moves'), ['cooking', 'dancemoves']);
});

test('keywordToHashtags: empty inputs', () => {
  assert.deepEqual(keywordToHashtags(''), []);
  assert.deepEqual(keywordToHashtags(null), []);
});

test('scoreCreator: includes diggCount + commentCount + shareCount', () => {
  const videos = [{ diggCount: 1000, commentCount: 50, shareCount: 25 }];
  const score = scoreCreator(videos, new Set(['a']));
  assert.ok(score > 20); // 20 from tag boost + log-scaled engagement
});

test('scoreCreator: legacy keys (likes/comments/shares) work too', () => {
  const videos = [{ likes: 1000, comments: 50, shares: 25 }];
  const a = scoreCreator(videos, new Set(['x']));
  const b = scoreCreator([{ diggCount: 1000, commentCount: 50, shareCount: 25 }], new Set(['x']));
  assert.equal(a, b);
});

test('scoreCreator: caps at 100', () => {
  const videos = Array.from({ length: 50 }, () => ({ diggCount: 1_000_000 }));
  const score = scoreCreator(videos, new Set(['a', 'b', 'c']));
  assert.ok(score <= 100);
});

test('searchTikTokHashtag: returns error when APIFY_TOKEN missing', async () => {
  const prev = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../tiktok-discovery')];
  const { searchTikTokHashtag: fn } = require('../tiktok-discovery');
  const r = await fn({ keywords: 'ai' });
  assert.equal(r.success, false);
  assert.match(r.error, /APIFY_TOKEN/);
  if (prev) process.env.APIFY_TOKEN = prev;
});
