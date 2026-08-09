/**
 * LLM provider abstraction.
 *
 * A thin layer over Anthropic + OpenAI HTTP APIs so every agent can say
 * `llm.complete(...)` without coupling to a specific provider. Supports:
 *
 *   - Provider routing: pick by name or let ROUTER choose by capability
 *   - Token + cost metering per call
 *   - Response caching (keyed on provider:model:prompt) for idempotent use
 *   - Tool use / function calling (Anthropic + OpenAI both supported)
 *   - Retry with exponential backoff on 429/5xx
 *
 * Metering contract: a cache hit is FREE. It reports `usdCents: 0` and is kept
 * out of the billed counters, because no request was made and no provider
 * charged us. Its token counts and `cachedUsdCents` (the spend avoided) survive
 * for visibility, and `stats.cached` accumulates the same volume so the
 * persisted ledger in `agent_runs` stays reconcilable against getStats(). Only
 * calls with `temperature` 0 or absent are cacheable at all — see complete().
 *
 * NOT supported: streaming. Every provider call is a single fetch + json().
 * (This header claimed "Streaming via async iterator" for a long time; it was
 * never implemented, and Conductor's plan-progress SSE had to fall back to
 * coarse server-side phases because of it.)
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — for claude-*
 *   OPENAI_API_KEY     — for gpt-*
 *   LLM_DEFAULT_PROVIDER — "anthropic" | "openai" (default: auto-detect)
 *   LLM_CACHE_TTL_MS   — prompt cache TTL (default 10 min)
 */

const fetch = require('../proxy-fetch');
const { defaultCache } = require('../cache');

const CACHE_TTL = parseInt(process.env.LLM_CACHE_TTL_MS) || 10 * 60 * 1000;
const DEFAULT_PROVIDER = process.env.LLM_DEFAULT_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY ? 'anthropic' :
   process.env.OPENAI_API_KEY ? 'openai' :
   process.env.GOOGLE_AI_API_KEY ? 'google' : null);

// Usage accumulator (reset via resetStats)
//
// `byProvider` / `byModel` / `totalUsdCents` meter money that actually left the
// building: recordUsage() runs on the live-call path only, so a cache hit adds
// nothing to them. But a cache hit still reports its original token counts (see
// complete()), and those reach `agent_runs` — so with cached volume tracked
// nowhere, this meter and the persisted ledger could never be reconciled; the
// ledger would just look inexplicably larger with no way to say why.
//
// `cached` closes that gap. It counts hits separately, and its `usdCents` is
// spend *avoided* rather than spend incurred. Within one process lifetime, over
// the runs that process recorded, both of these hold:
//
//   SUM(agent_runs.cost_usd_cents) === totalUsdCents
//   SUM(agent_runs.input_tokens)   === Σ byProvider[*].inputTokens + cached.inputTokens
//
// Money agrees outright; tokens agree once cached volume is added back.
const emptyCacheBucket = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, usdCents: 0 });

const stats = {
  byProvider: {},   // provider → { calls, inputTokens, outputTokens, usdCents }
  byModel: {},
  totalUsdCents: 0,
  cached: emptyCacheBucket(),   // cache hits: free, but not invisible
};

function recordUsage(provider, model, inputTokens, outputTokens, usdCents) {
  const init = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, usdCents: 0 });
  stats.byProvider[provider] = stats.byProvider[provider] || init();
  stats.byModel[model] = stats.byModel[model] || init();
  for (const bucket of [stats.byProvider[provider], stats.byModel[model]]) {
    bucket.calls += 1;
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.usdCents += usdCents;
  }
  stats.totalUsdCents += usdCents;
}

/**
 * Record a cache hit. Deliberately NOT recordUsage(): no request was made, so
 * no provider charged us, and folding this into the billed buckets would
 * reintroduce exactly the over-billing this separation exists to prevent.
 * `avoidedUsdCents` is what the hit would have cost had it gone out live.
 */
function recordCacheHit(inputTokens, outputTokens, avoidedUsdCents) {
  stats.cached.calls += 1;
  stats.cached.inputTokens += inputTokens;
  stats.cached.outputTokens += outputTokens;
  stats.cached.usdCents += avoidedUsdCents;
}

function getStats() {
  return JSON.parse(JSON.stringify(stats));
}

function resetStats() {
  stats.byProvider = {};
  stats.byModel = {};
  stats.totalUsdCents = 0;
  stats.cached = emptyCacheBucket();
}

// Pricing per 1M tokens. Update as prices change.
// (As of 2026-04 — ballpark; actual billing may differ.)
const PRICING = {
  'claude-opus-4': { input: 1500, output: 7500 },       // $15 / $75 per 1M → cents
  'claude-opus-4-5': { input: 1500, output: 7500 },
  'claude-sonnet-4': { input: 300, output: 1500 },
  'claude-sonnet-4-5': { input: 300, output: 1500 },
  'claude-haiku-4': { input: 25, output: 125 },
  'claude-haiku-4-5': { input: 25, output: 125 },
  // Fallback aliases (3.5 series)
  'claude-3-5-sonnet-latest': { input: 300, output: 1500 },
  'claude-3-5-haiku-latest': { input: 80, output: 400 },
  'gpt-5': { input: 750, output: 3000 },
  'gpt-4o': { input: 250, output: 1000 },
  'gpt-4o-mini': { input: 15, output: 60 },
  // Google Gemini — very cheap Flash tier; use for structured-output tasks
  'gemini-2.0-flash': { input: 10, output: 40 },        // $0.10 / $0.40 per 1M
  'gemini-2.5-flash': { input: 30, output: 250 },       // $0.30 / $2.50 per 1M
  'gemini-2.5-pro': { input: 125, output: 500 },        // $1.25 / $10 per 1M
  'gemini-1.5-flash': { input: 7, output: 30 },         // legacy
  'gemini-1.5-pro': { input: 125, output: 500 },
};

function computeCostCents(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return 0;
  // PRICING values are cents per 1M tokens. Scale by (tokens / 1M).
  return Math.round((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

function cacheKey(provider, model, messages, tools) {
  // Cheap hash for prompt cache. Not cryptographic.
  const raw = JSON.stringify({ provider, model, messages, tools });
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return `llm:${provider}:${model}:${h.toString(36)}`;
}

async function retry(fn, { maxAttempts = 3, baseMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable !== false && (e.status === 429 || (e.status >= 500 && e.status < 600) || e.code === 'ECONNRESET');
      if (!retryable || attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200)));
    }
  }
  throw lastErr;
}

// ============================================================================
// Anthropic (claude-*)

async function callAnthropic({ model, messages, system, tools, maxTokens = 1024, temperature = 0.7 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;

  const res = await retry(async () => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = new Error(`Anthropic API ${r.status}: ${await r.text().then(t => t.slice(0, 300))}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });

  const textBlocks = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const toolUses = (res.content || []).filter(b => b.type === 'tool_use');
  const inputTokens = res.usage?.input_tokens || 0;
  const outputTokens = res.usage?.output_tokens || 0;
  const usdCents = computeCostCents(model, inputTokens, outputTokens);
  recordUsage('anthropic', model, inputTokens, outputTokens, usdCents);

  return {
    provider: 'anthropic',
    model,
    text: textBlocks,
    toolUses,
    raw: res,
    usage: { inputTokens, outputTokens, usdCents },
    stopReason: res.stop_reason,
  };
}

// ============================================================================
// Google Gemini (gemini-*)
//
// API:   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=KEY
//
// Gemini's schema differs from Anthropic/OpenAI:
//   - Messages use role 'user'/'model' (no 'assistant'/'system' — system goes in
//     systemInstruction at top level)
//   - Tools use `tools: [{ functionDeclarations: [...] }]`
//   - Tool use responses come back as parts with `functionCall: { name, args }`
//
// We translate on the way in and out so the caller can pretend it's all the
// same interface.

function toGeminiMessages(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema || t.parameters,
    })),
  }];
}

async function callGemini({ model, messages, system, tools, maxTokens = 1024, temperature = 0.7 }) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`;
  const body = {
    contents: toGeminiMessages(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gTools = toGeminiTools(tools);
  if (gTools) body.tools = gTools;

  const res = await retry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = new Error(`Gemini API ${r.status}: ${await r.text().then(t => t.slice(0, 300))}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });

  const candidate = res.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  const toolCalls = parts
    .filter(p => p.functionCall)
    .map(p => ({
      type: 'tool_use',
      id: `gemini-${p.functionCall.name}-${Math.random().toString(36).slice(2, 8)}`,
      name: p.functionCall.name,
      input: p.functionCall.args || {},
    }));
  const usage = res.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const usdCents = computeCostCents(model, inputTokens, outputTokens);
  recordUsage('google', model, inputTokens, outputTokens, usdCents);

  return {
    provider: 'google',
    model,
    text,
    toolUses: toolCalls,
    raw: res,
    usage: { inputTokens, outputTokens, usdCents },
    stopReason: candidate?.finishReason,
  };
}

// ============================================================================
// OpenAI (gpt-*)

async function callOpenAI({ model, messages, system, tools, maxTokens = 1024, temperature = 0.7 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const normalizedMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = {
    model,
    messages: normalizedMessages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || t.parameters } }));
  }

  const res = await retry(async () => {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = new Error(`OpenAI API ${r.status}: ${await r.text().then(t => t.slice(0, 300))}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });

  const choice = res.choices?.[0];
  const text = choice?.message?.content || '';
  const toolCalls = (choice?.message?.tool_calls || []).map(tc => ({
    type: 'tool_use',
    id: tc.id,
    name: tc.function.name,
    input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })(),
  }));
  const inputTokens = res.usage?.prompt_tokens || 0;
  const outputTokens = res.usage?.completion_tokens || 0;
  const usdCents = computeCostCents(model, inputTokens, outputTokens);
  recordUsage('openai', model, inputTokens, outputTokens, usdCents);

  return {
    provider: 'openai',
    model,
    text,
    toolUses: toolCalls,
    raw: res,
    usage: { inputTokens, outputTokens, usdCents },
    stopReason: choice?.finish_reason,
  };
}

// ============================================================================
// Unified entry point

/**
 * Resolve which provider + model a `complete()` call would actually use,
 * without making the call. Callers that want to *report* the target before a
 * long request (the Conductor's `calling_llm` phase) need this; `complete()`
 * itself uses it so the two can never drift.
 *
 * @returns {{ provider: string|null, model: string|null }}
 */
function resolveTarget({ provider, model } = {}) {
  const effectiveProvider = provider || DEFAULT_PROVIDER || null;
  if (!effectiveProvider) return { provider: null, model: null };
  // Default model per provider — overridable via {PROVIDER}_MODEL env vars.
  const effectiveModel = model || {
    anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    openai: process.env.OPENAI_MODEL || 'gpt-4o',
    google: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
  }[effectiveProvider] || null;
  return { provider: effectiveProvider, model: effectiveModel };
}

async function complete({
  provider,
  model,
  messages,
  system,
  tools,
  maxTokens,
  temperature,
  cache = true,
}) {
  const { provider: effectiveProvider, model: effectiveModel } = resolveTarget({ provider, model });
  if (!effectiveProvider) {
    throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  // Caching — skip when temperature > 0 and no explicit opt-in
  const shouldCache = cache && (temperature === undefined || temperature === 0);
  const cKey = shouldCache ? cacheKey(effectiveProvider, effectiveModel, messages, tools) : null;
  if (cKey) {
    const cached = defaultCache.get(cKey);
    if (cached) {
      // A cache hit costs nothing, and recordUsage() is deliberately not
      // called for it — so the in-memory stats already treat it as free.
      // Returning the original call's `usage` unchanged made callers that
      // persist it (agent_runs, and therefore the usage ledger) bill real
      // cents for a request that never left the process, and disagree with
      // getStats(). Report zero spend, keep the token counts for visibility,
      // and let `fromCache` explain the discrepancy to anyone comparing.
      //
      // The stored entry is never mutated — `usage` below is a fresh object on
      // every hit, built from the original — so `cachedUsdCents` stays accurate
      // across repeat hits on the same key rather than decaying to zero.
      const base = cached.usage || {};
      const avoidedUsdCents = base.usdCents || 0;
      // Tracked here, not in the billed buckets, so the persisted ledger's
      // token counts remain reconcilable against getStats(). See `stats`.
      recordCacheHit(base.inputTokens || 0, base.outputTokens || 0, avoidedUsdCents);
      const usage = cached.usage
        ? { ...base, usdCents: 0, billedUsdCents: 0, cachedUsdCents: avoidedUsdCents }
        : cached.usage;
      return { ...cached, usage, fromCache: true };
    }
  }

  let result;
  if (effectiveProvider === 'anthropic') {
    result = await callAnthropic({ model: effectiveModel, messages, system, tools, maxTokens, temperature });
  } else if (effectiveProvider === 'openai') {
    result = await callOpenAI({ model: effectiveModel, messages, system, tools, maxTokens, temperature });
  } else if (effectiveProvider === 'google') {
    result = await callGemini({ model: effectiveModel, messages, system, tools, maxTokens, temperature });
  } else {
    throw new Error(`Unsupported LLM provider: ${effectiveProvider}`);
  }

  if (cKey) defaultCache.set(cKey, result, CACHE_TTL);
  return result;
}

function isConfigured(provider) {
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  if (provider === 'google') return !!process.env.GOOGLE_AI_API_KEY;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_AI_API_KEY);
}

/**
 * Embed one or more texts as dense vectors. Used by brand-voice similarity
 * (pgvector) and RAG lookup.
 *
 * Currently routes to OpenAI `text-embedding-3-small` (1536-dim) — cheapest
 * model that covers multilingual content well. Returns { vectors, model,
 * dims, usdCents }. Callers persist into a pgvector column.
 *
 * @param {string|string[]} input   single string or array
 * @param {object} [opts]
 * @param {string} [opts.model='text-embedding-3-small']
 * @param {string} [opts.provider='openai']   only 'openai' supported for now
 */
async function embed(input, opts = {}) {
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) return { vectors: [], model: null, dims: 0, usdCents: 0 };
  const provider = opts.provider || 'openai';
  if (provider !== 'openai') throw new Error(`Embedding provider not supported: ${provider}`);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured — cannot embed');
  const model = opts.model || 'text-embedding-3-small';

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  // $0.02 per 1M tokens for text-embedding-3-small as of 2026-04 → 2 cents / 1M tokens.
  const inputTokens = data.usage?.total_tokens || 0;
  const usdCents = (inputTokens / 1_000_000) * 2;
  recordUsage('openai', model, inputTokens, 0, usdCents);
  const vectors = (data.data || []).map(d => d.embedding);
  return {
    vectors,
    model,
    dims: vectors[0]?.length || 0,
    inputTokens,
    usdCents,
  };
}

module.exports = {
  complete,
  resolveTarget,
  embed,
  isConfigured,
  getStats,
  resetStats,
  computeCostCents,
  PRICING,
  // exported for tests — lets a test prime defaultCache for the exact key
  // complete() will look up, so cache-hit accounting is testable offline.
  cacheKey,
};
