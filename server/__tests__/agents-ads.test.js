const { test } = require('node:test');
const assert = require('node:assert/strict');

const ads = require('../agents-v2/ads');

test('ads agent: shape matches the Agent contract', () => {
  assert.equal(ads.id, 'ads');
  assert.ok(ads.name && ads.description && ads.version);
  assert.ok(Array.isArray(ads.capabilities) && ads.capabilities.includes('ads.plan'));
  assert.equal(typeof ads.run, 'function');
  assert.equal(typeof ads.costEstimate, 'function');
  const cost = ads.costEstimate();
  assert.ok(cost.tokens > 0 && cost.usdCents > 0);
});

test('ads agent: input validation rejects missing required fields', async () => {
  const ctx = { emit: () => {} };
  await assert.rejects(() => ads.run({}, ctx), /brand is required/);
  await assert.rejects(() => ads.run({ brand: 'X' }, ctx), /objective is required/);
  await assert.rejects(() => ads.run({ brand: 'X', objective: 'conversion' }, ctx), /total_budget_usd/);
});

test('ads agent: throws when LLM not configured', async () => {
  const orig = {
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
    G: process.env.GOOGLE_AI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  // Reload llm so its DEFAULT_PROVIDER is recomputed without keys
  delete require.cache[require.resolve('../llm')];
  delete require.cache[require.resolve('../agents-v2/ads')];
  const freshAds = require('../agents-v2/ads');
  const ctx = { emit: () => {} };
  await assert.rejects(
    () => freshAds.run({ brand: 'X', objective: 'awareness', total_budget_usd: 100 }, ctx),
    /LLM provider not configured/
  );
  if (orig.A) process.env.ANTHROPIC_API_KEY = orig.A;
  if (orig.O) process.env.OPENAI_API_KEY = orig.O;
  if (orig.G) process.env.GOOGLE_AI_API_KEY = orig.G;
});

test('ads agent: registers with the runtime via agents-v2/index.js', () => {
  delete require.cache[require.resolve('../agent-runtime')];
  const runtime = require('../agent-runtime');
  const { registerAll } = require('../agents-v2');
  const ids = registerAll();
  assert.ok(ids.includes('ads'), 'expected ads agent id in registered list');
  const a = runtime.getAgent('ads');
  assert.ok(a);
  assert.equal(a.id, 'ads');
});
