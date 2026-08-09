/**
 * Contract tests between brand-voice-search.js and llm.embed().
 *
 * Roadmap card D3 ("pgvector wiring") was marked complete, but both call
 * sites invoked `llm.embed({ texts: [...] })` — passing an options-shaped
 * object where the function expects a string or string[] — and then indexed
 * the returned `{ vectors, model, dims }` object as if it were an array. So
 * the call either threw (swallowed by a warn) or produced undefined:
 * findBestBrandVoice() could only ever return null, and brand-voice
 * similarity had never actually run in production.
 *
 * These tests pin the argument shape and the return destructuring, so the
 * two sides can't drift apart silently again.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LLM_PATH = require.resolve('../llm');
const BVS_PATH = require.resolve('../brand-voice-search');

// Swap in a recording stub for ../llm, load brand-voice-search fresh.
function withStubbedLlm(embedImpl) {
  delete require.cache[BVS_PATH];
  const calls = [];
  const original = require.cache[LLM_PATH];
  require.cache[LLM_PATH] = {
    exports: {
      embed: async (...args) => { calls.push(args); return embedImpl(...args); },
      complete: async () => ({ text: '', usage: {} }),
      isConfigured: () => true,
    },
    loaded: true,
    id: LLM_PATH,
    filename: LLM_PATH,
    children: [],
    parent: null,
  };
  const bvs = require('../brand-voice-search');
  const restore = () => {
    delete require.cache[BVS_PATH];
    if (original) require.cache[LLM_PATH] = original;
    else delete require.cache[LLM_PATH];
  };
  return { bvs, calls, restore };
}

// The real embed() shape, so the stub can't be more forgiving than production.
function realShapeEmbed(input) {
  const texts = Array.isArray(input) ? input : [input];
  assert.ok(
    texts.every(t => typeof t === 'string'),
    `llm.embed() expects a string or string[]; got ${JSON.stringify(input)}`
  );
  return { vectors: texts.map(() => [0.1, 0.2, 0.3]), model: 'stub', dims: 3, inputTokens: 1, usdCents: 0 };
}

test('embedBrandVoice passes an array of strings and reads .vectors', async () => {
  const { bvs, calls, restore } = withStubbedLlm(realShapeEmbed);
  try {
    const vec = await bvs.embedBrandVoice({ name: 'Playful', tone: 'witty', description: 'fun and light' });
    assert.deepEqual(vec, [0.1, 0.2, 0.3], 'must return the first vector, not undefined');
    assert.equal(calls.length, 1);
    const [input] = calls[0];
    assert.ok(Array.isArray(input), 'input must be an array, not an options object');
    assert.ok(input.every(t => typeof t === 'string'));
  } finally { restore(); }
});

test('findBestBrandVoice embeds the brief with the same contract', async () => {
  const { bvs, calls, restore } = withStubbedLlm(realShapeEmbed);
  try {
    const db = {
      query: async () => ({ rows: [] }),
      queryOne: async () => null,
      exec: async () => ({}),
    };
    await bvs.findBestBrandVoice({ workspaceId: 'ws1', brief: 'launch announcement', db, usePostgres: false });
    assert.equal(calls.length, 1, 'the brief must be embedded');
    const [input] = calls[0];
    assert.ok(Array.isArray(input) && typeof input[0] === 'string');
  } finally { restore(); }
});

test('an embed failure degrades to null instead of throwing', async () => {
  const { bvs, restore } = withStubbedLlm(async () => { throw new Error('OPENAI_API_KEY not configured'); });
  try {
    assert.equal(await bvs.embedBrandVoice({ name: 'x', tone: 'y' }), null);
  } finally { restore(); }
});

test('the old broken shape would now fail loudly in this test, not silently in prod', () => {
  // Documents the exact regression: an options-object input is not a string[]
  // and the real embed() would send it straight to the provider.
  assert.throws(() => realShapeEmbed({ texts: ['hello'] }), /expects a string or string\[\]/);
  // And the return value is an object, so [0] on it is undefined — which is
  // how the bug stayed invisible: no throw, just a permanent null result.
  assert.equal(realShapeEmbed(['hello'])[0], undefined);
  assert.deepEqual(realShapeEmbed(['hello']).vectors[0], [0.1, 0.2, 0.3]);
});
