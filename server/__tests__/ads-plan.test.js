/**
 * Tests for the Ads agent + the promise-wrap pattern used by the
 * POST /api/ads/plan endpoint.
 *
 * The endpoint itself is a thin wrapper around agentRuntime.createRun; we
 * verify both the agent's input validation and the wrap's complete/error
 * resolution semantics against a fresh runtime with a mock ads agent so we
 * don't require an LLM key.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshRuntime() {
  delete require.cache[require.resolve('../agent-runtime')];
  return require('../agent-runtime');
}

test('ads agent rejects missing required inputs', async () => {
  const ads = require('../agents-v2/ads');
  const ctx = { emit: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };

  await assert.rejects(ads.run({}, ctx), /brand is required/);
  await assert.rejects(ads.run({ brand: 'x' }, ctx), /objective is required/);
  await assert.rejects(ads.run({ brand: 'x', objective: 'conversion' }, ctx), /total_budget_usd is required/);
});

test('ads agent exposes expected metadata', () => {
  const ads = require('../agents-v2/ads');
  assert.equal(ads.id, 'ads');
  assert.ok(ads.capabilities.includes('ads.plan'));
  assert.ok(ads.inputSchema.required.includes('brand'));
  assert.ok(ads.inputSchema.required.includes('objective'));
  assert.ok(ads.inputSchema.required.includes('total_budget_usd'));
});

// The endpoint wraps createRun in a promise that resolves on 'complete'
// and rejects on 'error'. These tests validate that promise pattern using
// a mock agent so we don't need an LLM key.
function awaitRunResult(stream) {
  return new Promise((resolve, reject) => {
    stream.on('event', (evt) => {
      if (evt.type === 'complete') resolve({ plan: evt.data?.output, cost: evt.data?.cost });
      else if (evt.type === 'error') reject(new Error(evt.data?.message || 'agent error'));
    });
  });
}

test('ads.plan promise-wrap resolves with plan output on complete', async () => {
  const rt = freshRuntime();
  const mockPlan = {
    campaign_slug: 'test-launch-2026',
    objective: 'conversion',
    platforms: [{ platform: 'meta', creatives: [{ hook: 'h', headline: 'H' }], audience: {} }],
    budget: { total_usd: 5000, split: [{ platform: 'meta', pct: 100 }] },
    kpis: { primary: 'CPA ≤ $25' },
    execution: { mode: 'offline_plan' },
  };
  rt.registerAgent({
    id: 'ads',
    name: 'MockAds',
    async run() { return mockPlan; },
  });

  const { stream } = rt.createRun('ads', { brand: 'x', objective: 'conversion', total_budget_usd: 5000 }, {});
  const result = await awaitRunResult(stream);
  assert.equal(result.plan.campaign_slug, 'test-launch-2026');
  assert.equal(result.plan.execution.mode, 'offline_plan');
});

test('ads.plan promise-wrap rejects when agent throws', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'ads',
    name: 'MockAds',
    async run() { throw new Error('brand is required'); },
  });

  const { stream } = rt.createRun('ads', {}, {});
  await assert.rejects(awaitRunResult(stream), /brand is required/);
});
