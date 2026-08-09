/**
 * Cache-hit accounting contract for llm.complete().
 *
 * A cache hit makes no API call and incurs no provider charge, but it still
 * flows through every caller that persists `res.usage` into `agent_runs` — and
 * from there into `GET /api/usage`, which is meant to be the basis for tiered
 * billing. Before this was pinned down, a hit returned the ORIGINAL call's
 * usage verbatim, so the ledger charged full price for a request that never
 * left the process while `llm.getStats()` (which skips recordUsage() on the
 * cached path) reported it as free. The two meters disagreed by exactly the
 * cached volume.
 *
 * The semantics these tests fix in place are cost-based: we bill for money that
 * left the building, not for value delivered.
 *
 *   - a hit reports `usdCents: 0` — nothing is charged
 *   - it keeps `inputTokens` / `outputTokens` — the work is still visible
 *   - it carries `cachedUsdCents` — the saving stays auditable
 *   - `stats.cached` accumulates the same volume, so the persisted ledger and
 *     the in-memory counters RECONCILE instead of merely differing
 *
 * That last point is the one worth guarding: zeroing the cost alone still left
 * the ledger's token columns unexplainable from getStats().
 *
 * No network: every test primes the cache directly, so complete() returns from
 * the cache branch before any provider is reached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const LLM_PATH = require.resolve('../llm');
const VIDEO_PATH = require.resolve('../agents-v2/content-video');

const MODEL = 'claude-sonnet-4-5';

function freshLlm() {
  delete require.cache[LLM_PATH];
  // `../cache` is deliberately NOT reloaded: complete() and this test must
  // share the one defaultCache singleton for priming to be visible.
  const llm = require('../llm');
  require('../cache').defaultCache.clear();
  llm.resetStats();
  return llm;
}

/**
 * Store a result under the exact key complete() will compute, so the next
 * matching call is served from cache. `usage` mirrors a live call's shape:
 * real token counts and a real, non-zero cost.
 */
function primeCache(llm, messages, usage) {
  const key = llm.cacheKey('anthropic', MODEL, messages, undefined);
  require('../cache').defaultCache.set(key, {
    provider: 'anthropic',
    model: MODEL,
    text: 'cached answer',
    toolUses: [],
    raw: {},
    usage,
    stopReason: 'end_turn',
  }, 60_000);
  return key;
}

// temperature 0 is what makes a call cacheable at all; provider/model are
// explicit so the assertions do not depend on ambient env vars.
const hit = (messages) => ({
  provider: 'anthropic', model: MODEL, messages, temperature: 0,
});

test('cache hit: bills nothing, keeps tokens, and reports the avoided spend', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: zero cost' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  const res = await llm.complete(hit(messages));

  assert.equal(res.fromCache, true, 'served from cache');
  assert.equal(res.usage.usdCents, 0, 'a cache hit must not be billed');
  assert.equal(res.usage.billedUsdCents, 0);
  assert.equal(res.usage.cachedUsdCents, 111, 'the saving stays auditable');
  // Tokens survive: they are what the ledger reports as work done.
  assert.equal(res.usage.inputTokens, 1000);
  assert.equal(res.usage.outputTokens, 500);
  assert.equal(res.text, 'cached answer', 'the cached payload itself is intact');
});

test('cache hit: stays out of the billed counters', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: not billed' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  await llm.complete(hit(messages));
  const stats = llm.getStats();

  assert.equal(stats.totalUsdCents, 0, 'no money left the building');
  assert.deepEqual(stats.byProvider, {}, 'no provider was called');
  assert.deepEqual(stats.byModel, {});
});

test('cache hit: counted in stats.cached so the two meters reconcile', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: reconcile' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  const res = await llm.complete(hit(messages));

  // What a caller persists into agent_runs, mirroring agent-runtime/index.js.
  const persisted = {
    cost_usd_cents: res.usage.usdCents || 0,
    input_tokens: res.usage.inputTokens || 0,
    output_tokens: res.usage.outputTokens || 0,
  };

  const stats = llm.getStats();
  const billedTokens = Object.values(stats.byProvider)
    .reduce((sum, b) => sum + b.inputTokens, 0);

  // Money: the ledger and getStats() agree outright.
  assert.equal(persisted.cost_usd_cents, stats.totalUsdCents);
  // Tokens: the ledger records volume the billed counters deliberately skip.
  // It reconciles only once the cached bucket is added back — which is the
  // whole reason that bucket exists.
  assert.equal(persisted.input_tokens, billedTokens + stats.cached.inputTokens);
  assert.equal(stats.cached.calls, 1);
  assert.equal(stats.cached.inputTokens, 1000);
  assert.equal(stats.cached.outputTokens, 500);
  assert.equal(stats.cached.usdCents, 111, 'cached.usdCents is spend AVOIDED');
});

test('repeat hits on one key keep reporting the full saving', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: repeat' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  const first = await llm.complete(hit(messages));
  const second = await llm.complete(hit(messages));

  // Guards against zeroing the STORED entry instead of a per-hit copy, which
  // would silently decay the audit trail to zero after the first read.
  assert.equal(first.usage.cachedUsdCents, 111);
  assert.equal(second.usage.cachedUsdCents, 111);
  assert.equal(second.usage.usdCents, 0);

  const stats = llm.getStats();
  assert.equal(stats.cached.calls, 2);
  assert.equal(stats.cached.usdCents, 222, 'avoided spend accumulates per hit');
  assert.equal(stats.totalUsdCents, 0, 'still nothing billed');
});

test('resetStats clears the cached bucket too', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: reset' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  await llm.complete(hit(messages));
  assert.equal(llm.getStats().cached.calls, 1);

  llm.resetStats();
  assert.deepEqual(llm.getStats().cached, {
    calls: 0, inputTokens: 0, outputTokens: 0, usdCents: 0,
  });
});

test('cache hit with no usage on the stored entry does not fabricate one', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: no usage' }];
  primeCache(llm, messages, undefined);

  const res = await llm.complete(hit(messages));

  assert.equal(res.fromCache, true);
  assert.equal(res.usage, undefined, 'absent usage stays absent');
  // Nothing to count, but the hit still happened.
  const stats = llm.getStats();
  assert.equal(stats.cached.calls, 1);
  assert.equal(stats.cached.usdCents, 0);
  assert.equal(stats.totalUsdCents, 0);
});

test('a non-cacheable call (temperature > 0) never consults the cache', async () => {
  const llm = freshLlm();
  const messages = [{ role: 'user', content: 'cache-billing: hot temperature' }];
  primeCache(llm, messages, { inputTokens: 1000, outputTokens: 500, usdCents: 111 });

  // Same prompt, non-zero temperature: complete() must fall through to the
  // provider rather than serving the primed entry. With no API key set that
  // surfaces as a throw, which is exactly the proof we want — and it documents
  // why the bug stayed latent: every agent but community's classify pass sends
  // a non-zero temperature, so almost nothing is cacheable today.
  const origKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => llm.complete({ provider: 'anthropic', model: MODEL, messages, temperature: 0.7 }),
      /ANTHROPIC_API_KEY not set/
    );
  } finally {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  }
  assert.equal(llm.getStats().cached.calls, 0, 'no cache hit was recorded');
});

// ---------------------------------------------------------------------------
// Downstream: agents must not re-inflate a zero cost back into a charge.

/** Load content-video against a stubbed ../llm, then restore the real one. */
function withStubbedLlm(completeImpl, fn) {
  const original = require.cache[LLM_PATH];
  delete require.cache[VIDEO_PATH];
  require.cache[LLM_PATH] = {
    exports: { complete: completeImpl, isConfigured: () => true },
    loaded: true, id: LLM_PATH, filename: LLM_PATH, children: [], parent: null,
  };
  try {
    return fn(require('../agents-v2/content-video'));
  } finally {
    delete require.cache[VIDEO_PATH];
    if (original) require.cache[LLM_PATH] = original;
    else delete require.cache[LLM_PATH];
  }
}

const VIDEO_RESULT = (usage) => ({
  text: '',
  usage,
  toolUses: [{
    name: 'compose_video',
    input: { title: 'T', hook: 'H', beats: [{ voiceover: 'v', visual: 'x' }], cta: 'C' },
  }],
});

test('content-video: a zero-cost script is not re-billed at the 25c estimate', async () => {
  // `|| 25` treated a legitimate zero — a cache hit, or any model missing from
  // llm's PRICING table — as "cost unknown" and charged the estimate anyway.
  const out = await withStubbedLlm(
    async () => VIDEO_RESULT({ inputTokens: 1000, outputTokens: 500, usdCents: 0, cachedUsdCents: 111 }),
    (agent) => agent.run(
      { brief: 'b', include_voiceover: false },
      { emit: () => {}, logger: console }
    )
  );

  assert.equal(out.cost.usdCents, 0, 'zero cost must survive into the agent output');
  assert.equal(out.cost.inputTokens, 1000, 'tokens still reported');
  assert.equal(out.cost.outputTokens, 500);
});

test('content-video: genuinely absent usage still falls back to the estimate', async () => {
  const out = await withStubbedLlm(
    async () => VIDEO_RESULT(undefined),
    (agent) => agent.run(
      { brief: 'b', include_voiceover: false },
      { emit: () => {}, logger: console }
    )
  );

  assert.equal(out.cost.usdCents, 25, 'unknown cost is still estimated, not zeroed');
});
