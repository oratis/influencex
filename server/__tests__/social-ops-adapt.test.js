const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adapt, capabilities } = require('../../packages/social-ops');
const { adaptForPlatform, adaptForPlatforms, splitThread } = adapt;

test('x: short text stays intact and carries hashtags + link', () => {
  const v = adaptForPlatform('x', { body: 'Hello world', hashtags: ['ai', '#story'], link: 'https://cuddler.ai/s/abc?utm_content=p1' });
  assert.equal(v.mode, 'api_direct');
  assert.ok(v.text.startsWith('Hello world'));
  assert.ok(v.text.includes('#ai #story'));
  assert.ok(v.text.endsWith('https://cuddler.ai/s/abc?utm_content=p1'));
  assert.equal(v.threadParts, null);
  assert.ok(v.charCount <= 280);
  assert.deepEqual(v.warnings, []);
});

test('x: long text becomes a thread, link stays on the head post, nothing is lost', () => {
  const body = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} explains one more beat of the story in a fairly verbose way.`).join(' ');
  const v = adaptForPlatform('x', { body, link: 'https://cuddler.ai/s/abc' });
  assert.ok(v.charCount <= 280, `head ${v.charCount}`);
  assert.ok(v.text.includes('https://cuddler.ai/s/abc'));
  assert.ok(Array.isArray(v.threadParts) && v.threadParts.length >= 2);
  for (const part of v.threadParts) assert.ok(part.length <= 280, part.length);
  const joined = [v.text, ...v.threadParts].join(' ');
  for (let i = 1; i <= 12; i++) assert.ok(joined.includes(`Sentence number ${i} `), `beat ${i} survived`);
  assert.ok(v.warnings.some((w) => /thread/.test(w)));
});

test('splitThread hard-wraps text with no sentence boundaries instead of truncating', () => {
  const parts = splitThread('a'.repeat(700), 280);
  assert.ok(parts.length >= 3);
  assert.equal(parts.map((p) => p.replace(/ \d+\/\d+$/, '')).join('').length, 700);
  for (const p of parts) assert.ok(p.length <= 280);
  assert.deepEqual(splitThread('short', 280), ['short']);
});

test('xiaohongshu: manual package with 20-char title cap and hashtag dedupe', () => {
  const v = adaptForPlatform('xiaohongshu', { title: '一二三四五六七八九十一二三四五六七八九十一二三', body: '正文 #故事 内容', hashtags: ['故事', 'AI'], imageUrls: Array(20).fill('https://x/i.jpg') });
  assert.equal(v.mode, 'manual_package');
  assert.equal(v.title.length, 20);
  assert.ok(v.warnings.some((w) => /title exceeds 20/.test(w)));
  assert.equal(v.package.images.length, 18);
  assert.deepEqual(v.package.hashtags, ['故事', 'AI']);
  assert.equal(v.package.video, null);
});

test('wechat_channels: manual package with cover spec', () => {
  const v = adaptForPlatform('wechat_channels', { body: 'desc', videoUrl: 'https://x/v.mp4', coverUrl: 'https://x/c.jpg' });
  assert.equal(v.mode, 'manual_package');
  assert.equal(v.package.video, 'https://x/v.mp4');
  assert.equal(v.package.cover, 'https://x/c.jpg');
});

test('wechat_mp: title 64 cap, digest 120 cap, html paragraphs escaped', () => {
  const v = adaptForPlatform('wechat_mp', { title: 'T'.repeat(70), body: `${'摘'.repeat(130)}\n\n第二段 <b>x</b>` });
  assert.equal(v.title.length, 64);
  assert.equal(v.digest.length, 120);
  assert.ok(v.html.includes('<p style='));
  assert.ok(v.html.includes('&lt;b&gt;'));
  assert.ok(!v.html.includes('<b>'));
});

test('youtube: title 100 cap, video-only, requires media warning', () => {
  const v = adaptForPlatform('youtube', { title: 'x'.repeat(120), body: 'desc', imageUrls: ['https://x/i.jpg'] });
  assert.equal(v.title.length, 100);
  assert.deepEqual(v.imageUrls, []);
  assert.ok(v.warnings.some((w) => /requires media/.test(w)));
  assert.ok(v.warnings.some((w) => /video-only/.test(w)));
});

test('instagram: hashtag cap 30 is enforced and reported', () => {
  const tags = Array.from({ length: 35 }, (_, i) => `t${i}`);
  const v = adaptForPlatform('instagram', { body: 'cap', hashtags: tags, imageUrls: ['https://x/i.jpg'] });
  assert.equal(v.hashtags.length, 30);
  assert.ok(v.warnings.some((w) => /35 hashtags > 30/.test(w)));
});

test('bilibili: cover required warning; reddit: title cap 300', () => {
  const b = adaptForPlatform('bilibili', { title: 't', body: 'd', videoUrl: 'https://x/v.mp4' });
  assert.ok(b.warnings.some((w) => /cover/.test(w)));
  const r = adaptForPlatform('reddit', { title: 'x'.repeat(400), body: 'd' });
  assert.equal(r.title.length, 300);
});

test('discord: 2000 cap, hashtags not inlined', () => {
  const v = adaptForPlatform('discord', { body: 'y'.repeat(2500), hashtags: ['a'] });
  assert.equal(v.charCount, 2000);
  assert.ok(!v.text.includes('#a'));
  assert.deepEqual(v.hashtags, ['a']);
});

test('unknown platform returns an error object; adaptForPlatforms fans out', () => {
  assert.ok(adaptForPlatform('myspace', { body: 'x' }).error);
  const all = adaptForPlatforms(capabilities.PLATFORM_IDS, { title: 't', body: 'b', videoUrl: 'https://x/v.mp4', coverUrl: 'https://x/c.jpg', imageUrls: ['https://x/i.jpg'] });
  assert.equal(all.length, 12);
  for (const v of all) assert.ok(!v.error, v.platform);
});
