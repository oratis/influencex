/**
 * LLM abstraction tests — pure unit tests, no actual API calls.
 * Provider integration is tested manually (requires keys).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshLlm() {
  delete require.cache[require.resolve('../llm')];
  return require('../llm');
}

test('isConfigured reflects env vars', () => {
  const origA = process.env.ANTHROPIC_API_KEY;
  const origO = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let llm = freshLlm();
  assert.equal(llm.isConfigured(), false);

  process.env.ANTHROPIC_API_KEY = 'sk-test';
  llm = freshLlm();
  assert.equal(llm.isConfigured(), true);
  assert.equal(llm.isConfigured('anthropic'), true);
  assert.equal(llm.isConfigured('openai'), false);

  process.env.ANTHROPIC_API_KEY = origA;
  process.env.OPENAI_API_KEY = origO;
});

test('computeCostCents: claude-sonnet-4 pricing', () => {
  const llm = freshLlm();
  // 1M input + 1M output tokens of sonnet-4 = $3 + $15 = $18 = 1800 cents
  // We pass tokens directly (not millions), so scale accordingly
  const cost = llm.computeCostCents('claude-sonnet-4', 1_000_000, 1_000_000);
  assert.equal(cost, 1800);
});

test('computeCostCents: zero cost for unknown model', () => {
  const llm = freshLlm();
  assert.equal(llm.computeCostCents('fictional-model-x', 1000, 1000), 0);
});

test('embed: throws helpful error when OPENAI_API_KEY missing', async () => {
  const orig = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const llm = freshLlm();
  await assert.rejects(
    () => llm.embed('hello'),
    /OPENAI_API_KEY not configured/
  );
  if (orig) process.env.OPENAI_API_KEY = orig;
});

test('embed: empty input returns empty result without hitting network', async () => {
  const llm = freshLlm();
  const r = await llm.embed([]);
  assert.deepEqual(r, { vectors: [], model: null, dims: 0, usdCents: 0 });
});

test('embed: rejects unsupported provider', async () => {
  const llm = freshLlm();
  await assert.rejects(
    () => llm.embed('x', { provider: 'anthropic' }),
    /not supported/
  );
});

test('computeCostCents: small values round cleanly', () => {
  const llm = freshLlm();
  // 10000 input + 5000 output on claude-haiku-4
  // haiku-4 = 0.25 input / 1.25 output per 1M → ¢25 / ¢125 per 1M
  // 10000 * 25 / 1M + 5000 * 125 / 1M = 0.25 + 0.625 = 0.875 cents → rounds to 1
  const cost = llm.computeCostCents('claude-haiku-4', 10000, 5000);
  assert.ok(cost >= 0 && cost <= 2);
});

test('getStats + resetStats', () => {
  const llm = freshLlm();
  llm.resetStats();
  const stats = llm.getStats();
  assert.deepEqual(stats.byProvider, {});
  assert.equal(stats.totalUsdCents, 0);
});

test('PRICING table exposes known models', () => {
  const llm = freshLlm();
  assert.ok(llm.PRICING['claude-sonnet-4']);
  assert.ok(llm.PRICING['gpt-4o']);
  assert.ok(llm.PRICING['gpt-4o-mini']);
});
