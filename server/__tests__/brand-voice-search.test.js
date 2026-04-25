const { test } = require('node:test');
const assert = require('node:assert');
const bv = require('../brand-voice-search');

test('cosineSim: identical vectors → 1', () => {
  assert.strictEqual(bv.cosineSim([1, 0, 0], [1, 0, 0]), 1);
});

test('cosineSim: orthogonal → 0', () => {
  assert.strictEqual(bv.cosineSim([1, 0], [0, 1]), 0);
});

test('cosineSim: opposite → -1', () => {
  assert.strictEqual(bv.cosineSim([1, 0], [-1, 0]), -1);
});

test('cosineSim: mismatched length → -1', () => {
  assert.strictEqual(bv.cosineSim([1, 2, 3], [1, 2]), -1);
});

test('cosineSim: zero vector → -1 (avoid div-by-zero)', () => {
  assert.strictEqual(bv.cosineSim([0, 0], [1, 0]), -1);
});

test('parseJsonField: tolerates array, JSON string, garbage', () => {
  assert.deepStrictEqual(bv.parseJsonField(['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(bv.parseJsonField('["x","y"]'), ['x', 'y']);
  assert.deepStrictEqual(bv.parseJsonField('not json'), []);
  assert.deepStrictEqual(bv.parseJsonField(null), []);
  assert.deepStrictEqual(bv.parseJsonField(undefined), []);
});

test('composeBrandVoiceText: builds searchable text from voice fields', () => {
  const text = bv.composeBrandVoiceText({
    name: 'Bold + Direct',
    description: 'Founder-led startup voice',
    tone_words: ['confident', 'punchy'],
    do_examples: ['Shipped X. Cut Y by Z%.'],
    dont_examples: ['Synergy. Innovation. Solutions.'],
    style_guide: 'Numbers > adjectives.',
  });
  assert.match(text, /Bold \+ Direct/);
  assert.match(text, /confident, punchy/);
  assert.match(text, /Founder-led startup voice/);
  assert.match(text, /Shipped X/);
  assert.match(text, /Synergy/);
  assert.match(text, /Numbers > adjectives/);
});

test('composeBrandVoiceText: omits empty fields gracefully', () => {
  const text = bv.composeBrandVoiceText({ name: 'Minimal' });
  assert.strictEqual(text, 'Name: Minimal');
});

test('findBestBrandVoice: returns null when workspace has no voices', async () => {
  // Stub db that returns empty rows. We don't hit llm.embed because the
  // function checks brief + workspaceId first; it'll only call embed if
  // both are present, and then early-return on no rows.
  const fakeDb = {
    query: async () => ({ rows: [] }),
    queryOne: async () => null,
  };
  // No HUNTER / OPENAI key — embed will throw, function should swallow.
  const old = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await bv.findBestBrandVoice({
      workspaceId: 'ws1',
      brief: 'test brief',
      db: fakeDb,
      usePostgres: false,
    });
    assert.strictEqual(r, null);
  } finally {
    if (old.OPENAI_API_KEY) process.env.OPENAI_API_KEY = old.OPENAI_API_KEY;
  }
});

test('findBestBrandVoice: returns null when workspaceId or brief missing', async () => {
  assert.strictEqual(await bv.findBestBrandVoice({ workspaceId: null, brief: 'x', db: {} }), null);
  assert.strictEqual(await bv.findBestBrandVoice({ workspaceId: 'w', brief: '', db: {} }), null);
  assert.strictEqual(await bv.findBestBrandVoice({ workspaceId: 'w', brief: 'x', db: null }), null);
});
