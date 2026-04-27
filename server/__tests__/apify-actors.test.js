const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../apify-actors');

test('registry: exports list and get', () => {
  const all = registry.list();
  assert.ok(all.length >= 5);
  const ig = registry.get('apify/instagram-profile-scraper');
  assert.ok(ig);
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.kind, 'profile');
});

test('every actor has required shape', () => {
  for (const a of Object.values(registry.ACTORS)) {
    assert.ok(a.actorId, `actorId missing on ${JSON.stringify(a)}`);
    assert.ok(a.platform, `platform missing on ${a.actorId}`);
    assert.ok(a.kind, `kind missing on ${a.actorId}`);
    assert.equal(typeof a.buildInput, 'function');
    assert.equal(typeof a.normalize, 'function');
  }
});

test('instagram-profile.normalize: handles nominal item', () => {
  const ig = registry.get('apify/instagram-profile-scraper');
  const out = ig.normalize({
    username: 'demo',
    fullName: 'Demo User',
    profilePicUrl: 'http://x/y.jpg',
    followersCount: 500,
    followsCount: 100,
    postsCount: 25,
    biography: 'hi',
    verified: true,
  });
  assert.equal(out.platform, 'instagram');
  assert.equal(out.followers, 500);
  assert.equal(out.verified, true);
});

test('tiktok-profile.normalize: extracts authorMeta', () => {
  const tt = registry.get('clockworks/tiktok-scraper');
  const out = tt.normalize({
    authorMeta: { name: 'demo', nickName: 'Demo', fans: 9999, video: 50, signature: 'bio' },
  });
  assert.equal(out.followers, 9999);
  assert.equal(out.total_videos, 50);
  assert.equal(out.username, 'demo');
});

test('tiktok-profile.buildInput: accepts username only', () => {
  const tt = registry.get('clockworks/tiktok-scraper');
  const input = tt.buildInput({ username: 'foo' });
  assert.equal(input.profiles[0], 'https://www.tiktok.com/@foo');
});

test('hashtag actors: buildInput strips # prefix', () => {
  const igHash = registry.get('apify/instagram-hashtag-scraper');
  const ttHash = registry.get('clockworks/free-tiktok-scraper');
  assert.equal(igHash.buildInput({ hashtag: '#cooking' }).hashtags[0], 'cooking');
  assert.equal(ttHash.buildInput({ hashtag: '#cooking' }).hashtags[0], 'cooking');
});

test('list: returns metadata-only summary', () => {
  const summary = registry.list();
  for (const item of summary) {
    assert.ok(item.actorId);
    assert.ok(typeof item.costPerRunUsd === 'number');
    // Should NOT leak the function references
    assert.equal(item.normalize, undefined);
  }
});
