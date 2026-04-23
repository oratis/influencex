/**
 * Analytics Agent scaffold tests.
 *
 * No LLM key needed — covers metadata/schema shape, input validation, cost
 * scaling with metrics-payload size, and runtime registration.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshRuntime() {
  delete require.cache[require.resolve('../agent-runtime')];
  return require('../agent-runtime');
}

test('analytics agent exposes expected metadata + schema', () => {
  const a = require('../agents-v2/analytics');
  assert.equal(a.id, 'analytics');
  assert.ok(a.capabilities.includes('analytics.interpret'));
  assert.deepEqual(a.inputSchema.required, ['metrics']);
  assert.deepEqual(a.outputSchema.required, ['headline', 'insights', 'recommendations']);
});

test('analytics agent validates required inputs', async () => {
  const a = require('../agents-v2/analytics');
  const ctx = { emit: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };
  await assert.rejects(a.run({}, ctx), /metrics.*is required/i);
  await assert.rejects(a.run({ metrics: 'not-an-object' }, ctx), /metrics.*is required/i);
});

test('costEstimate scales with metrics payload size', () => {
  const a = require('../agents-v2/analytics');
  const tiny = a.costEstimate({ metrics: { a: 1 } });
  const big = a.costEstimate({ metrics: { rows: Array.from({ length: 500 }, (_, i) => ({ id: i, value: i * 2, label: `row-${i}` })) } });
  assert.ok(big.tokens > tiny.tokens, 'bigger payload should cost more tokens');
  assert.ok(big.usdCents >= tiny.usdCents, 'bigger payload should cost at least as many cents');
});

test('analytics agent registers with the runtime via registerAll', () => {
  const rt = freshRuntime();
  delete require.cache[require.resolve('../agents-v2')];
  const { registerAll } = require('../agents-v2');
  const ids = registerAll();
  assert.ok(ids.includes('analytics'), 'analytics agent missing from registerAll output');
  const meta = rt.getAgent('analytics');
  assert.ok(meta, 'analytics agent not retrievable from runtime after register');
  assert.equal(meta.id, 'analytics');
});

test('outputSchema insights/recommendations carry the right item shape', () => {
  const a = require('../agents-v2/analytics');
  const insight = a.outputSchema.properties.insights.items;
  assert.deepEqual(insight.required, ['title', 'detail']);
  assert.ok(insight.properties.category.enum.includes('platform'));

  const rec = a.outputSchema.properties.recommendations.items;
  assert.deepEqual(rec.required, ['action', 'rationale']);
  assert.ok(rec.properties.priority.enum.includes('high'));

  const anomaly = a.outputSchema.properties.anomalies.items;
  assert.deepEqual(anomaly.required, ['kind', 'description']);
  assert.deepEqual(anomaly.properties.kind.enum, ['spike', 'drop']);
});
