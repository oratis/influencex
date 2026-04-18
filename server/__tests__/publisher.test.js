const { test } = require('node:test');
const assert = require('node:assert/strict');
const publisher = require('../agents-v2/publisher');
const { adaptForPlatform, buildIntentUrl, splitThread } = publisher._internals;

test('adaptForPlatform: twitter under-limit stays intact', () => {
  const r = adaptForPlatform('twitter', { body: 'Hello world' });
  assert.equal(r.platform, 'twitter');
  assert.equal(r.text, 'Hello world');
  assert.equal(r.char_count, 11);
  assert.ok(r.intent_url.includes('intent/tweet'));
  assert.ok(r.intent_url.includes(encodeURIComponent('Hello world')));
});

test('adaptForPlatform: twitter long text produces thread', () => {
  const long = 'First sentence here. Second sentence is a bit longer. Third. Fourth is the biggest of all and comes with additional context to help tip it over. '.repeat(3);
  const r = adaptForPlatform('twitter', { body: long });
  assert.ok(Array.isArray(r.tweets));
  assert.ok(r.tweets.length >= 2);
  assert.ok(r.warnings.some(w => w.includes('280 chars')));
});

test('adaptForPlatform: appends CTA when room', () => {
  const r = adaptForPlatform('twitter', { body: 'Short', cta: 'Click here' });
  assert.ok(r.text.includes('Click here'));
});

test('adaptForPlatform: appends hashtags in intent URL', () => {
  const r = adaptForPlatform('twitter', { body: 'test', hashtags: ['ai', 'marketing'] });
  assert.ok(r.intent_url.includes(encodeURIComponent('#ai')));
  assert.ok(r.intent_url.includes(encodeURIComponent('#marketing')));
});

test('adaptForPlatform: handles each supported platform', () => {
  for (const platform of ['twitter', 'linkedin', 'facebook', 'reddit', 'pinterest', 'threads', 'bluesky', 'weibo']) {
    const r = adaptForPlatform(platform, { body: 'sample' });
    assert.equal(r.platform, platform);
    assert.ok(r.intent_url, `${platform} should produce an intent URL`);
  }
});

test('adaptForPlatform: rejects unknown platform', () => {
  const r = adaptForPlatform('unknown', { body: 'x' });
  assert.ok(r.error);
});

test('adaptForPlatform: warns when pinterest has no image', () => {
  const r = adaptForPlatform('pinterest', { body: 'no image here' });
  assert.ok(r.warnings.some(w => w.includes('image')));
});

test('adaptForPlatform: truncates oversize content for linkedin', () => {
  const body = 'x'.repeat(5000);
  const r = adaptForPlatform('linkedin', { body });
  assert.ok(r.text.length <= 3000);
  assert.ok(r.warnings.some(w => w.includes('exceeds linkedin')));
});

test('splitThread: short input returns single tweet', () => {
  const result = splitThread('hi there');
  assert.equal(result.length, 1);
  assert.equal(result[0], 'hi there');
});

test('splitThread: numbers multi-tweet output', () => {
  const body = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth. Sixth. Seventh. Eighth. Ninth. Tenth sentence that is much longer than the rest and almost certainly pushes us over.'.repeat(3);
  const r = splitThread(body, 100);
  assert.ok(r.length > 1);
  assert.ok(r[0].endsWith(`1/${r.length}`));
});

test('buildIntentUrl: returns null for unknown platform', () => {
  assert.equal(buildIntentUrl('myspace', { text: 'hi' }), null);
});

test('agent run produces results per platform', async () => {
  const agent = publisher;
  const events = [];
  const ctx = { emit: (type, data) => events.push({ type, data }) };
  const out = await agent.run({
    content: { title: 'Hello', body: 'World', hashtags: ['demo'] },
    platforms: ['twitter', 'linkedin', 'bluesky'],
  }, ctx);
  assert.equal(out.results.length, 3);
  assert.ok(events.some(e => e.type === 'progress'));
  for (const r of out.results) {
    assert.ok(r.intent_url);
  }
});

test('agent rejects missing platforms', async () => {
  const ctx = { emit: () => {} };
  await assert.rejects(
    publisher.run({ content: { body: 'x' }, platforms: [] }, ctx),
    /platforms/
  );
});
