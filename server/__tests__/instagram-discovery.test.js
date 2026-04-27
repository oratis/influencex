const { test } = require('node:test');
const assert = require('node:assert/strict');

const { keywordToHashtags, scoreCreator, searchInstagramHashtag } = require('../instagram-discovery');

test('keywordToHashtags: comma-separates and strips non-alphanumeric', () => {
  assert.deepEqual(keywordToHashtags('AI productivity, gaming setup'), [
    'aiproductivity',
    'gamingsetup',
  ]);
});

test('keywordToHashtags: drops empty segments and caps at 5', () => {
  const tags = keywordToHashtags('a, b, c, d, e, f, g, ,, ');
  assert.equal(tags.length, 5);
  assert.deepEqual(tags, ['a', 'b', 'c', 'd', 'e']);
});

test('keywordToHashtags: handles unicode (Chinese)', () => {
  // \p{L} matches Chinese characters; the hashtag scraper accepts them.
  assert.deepEqual(keywordToHashtags('健身 教练'), ['健身教练']);
});

test('keywordToHashtags: returns empty for null/undefined', () => {
  assert.deepEqual(keywordToHashtags(''), []);
  assert.deepEqual(keywordToHashtags(null), []);
  assert.deepEqual(keywordToHashtags(undefined), []);
});

test('scoreCreator: more matched hashtags => higher score', () => {
  const posts = [{ likesCount: 100, commentsCount: 10 }];
  const oneTag = scoreCreator(posts, new Set(['a']));
  const threeTags = scoreCreator(posts, new Set(['a', 'b', 'c']));
  assert.ok(threeTags > oneTag);
});

test('scoreCreator: log-scaled engagement caps the boost', () => {
  // Even a 10M-engagement post should not blow past the 40-point eng cap.
  const huge = scoreCreator([{ likesCount: 10_000_000 }], new Set(['x']));
  assert.ok(huge <= 100);
  assert.ok(huge > 50); // big number still scores high
});

test('scoreCreator: zero engagement still positive when hashtag matches', () => {
  const score = scoreCreator([{}], new Set(['x']));
  assert.equal(score, 20);
});

test('searchInstagramHashtag: returns error when APIFY_TOKEN missing', async () => {
  const prev = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  // Re-require to pick up the env change in apify-client.
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../instagram-discovery')];
  const { searchInstagramHashtag: fn } = require('../instagram-discovery');
  const r = await fn({ keywords: 'ai' });
  assert.equal(r.success, false);
  assert.match(r.error, /APIFY_TOKEN/);
  if (prev) process.env.APIFY_TOKEN = prev;
});

test('searchInstagramHashtag: returns error when no usable hashtags', async () => {
  // Force-enable apify so the token check passes; mock the runActor.
  process.env.APIFY_TOKEN = 'test-token';
  delete require.cache[require.resolve('../apify-client')];
  delete require.cache[require.resolve('../instagram-discovery')];
  const { searchInstagramHashtag: fn } = require('../instagram-discovery');
  // Pure punctuation strips to empty hashtags
  const r = await fn({ keywords: ',,, ,' });
  assert.equal(r.success, false);
  assert.match(r.error, /usable hashtags/);
  delete process.env.APIFY_TOKEN;
});
