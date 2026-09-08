'use strict';

/**
 * Content production pipeline — brief → plan → copy (per locale) → visual →
 * per-platform adaptation → vocabulary gate → package.
 *
 * The LLM and the image generator are INJECTED (`deps.llm.complete`,
 * `deps.imageGen`) so the same pipeline runs inside InfluenceX (its own
 * multi-provider router) and inside a host that brings its own models. No
 * provider SDK, no API key, no network call is made by this file itself.
 *
 * The vocabulary gate is where a brand's positioning discipline plugs in: a
 * host passes `lexicon` (banned terms / regexes) and every variant is checked
 * AFTER adaptation — the text that would actually be posted — with one
 * rewrite attempt fed the offending terms. A variant that still fails is
 * returned with `gate.ok === false`, never silently dropped.
 */

const { adaptForPlatform } = require('../adapt');
const { getPlatform } = require('../capabilities');

// ---------------------------------------------------------------- helpers ---

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function addCost(total, usage) {
  if (!usage) return total;
  return {
    inputTokens: (total.inputTokens || 0) + (usage.inputTokens || usage.input_tokens || 0),
    outputTokens: (total.outputTokens || 0) + (usage.outputTokens || usage.output_tokens || 0),
    usdCents: (total.usdCents || 0) + (usage.usdCents || 0),
    calls: (total.calls || 0) + 1,
  };
}

async function callJson(deps, { system, user, maxTokens = 1200, temperature = 0.7 }, cost) {
  if (!deps.llm || typeof deps.llm.complete !== 'function') throw new Error('pipeline: deps.llm.complete is required');
  const res = await deps.llm.complete({ system, messages: [{ role: 'user', content: user }], maxTokens, temperature });
  const parsed = extractJson(res && res.text);
  return { parsed, cost: addCost(cost, res && res.usage), raw: res && res.text };
}

/**
 * Vocabulary gate factory. `banned` are terms (case-insensitive; whole-word
 * for Latin script, substring for CJK), `patterns` are RegExp sources.
 */
function createLexiconGate(lexicon = {}) {
  const terms = (lexicon.banned || []).map((t) => String(t).trim()).filter(Boolean);
  const regexes = terms.map((t) => {
    const isCjk = /[㐀-鿿가-힯぀-ヿ]/.test(t);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { term: t, re: isCjk ? new RegExp(esc, 'giu') : new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'giu') };
  });
  for (const src of lexicon.patterns || []) regexes.push({ term: String(src), re: new RegExp(src, 'giu') });
  return function gate(text) {
    const hits = [];
    const s = String(text || '');
    for (const { term, re } of regexes) {
      re.lastIndex = 0;
      const m = re.exec(s);
      if (m) hits.push({ term, index: m.index, match: m[0] });
    }
    return { ok: hits.length === 0, hits };
  };
}

function variantText(v) {
  return [v.title, v.text, ...(v.threadParts || []), v.digest].filter(Boolean).join('\n');
}

// ----------------------------------------------------------------- stages ---

const PLAN_SYSTEM = `You are a senior social media strategist. Given a brief, produce a content plan as JSON only:
{"angle": "the one idea this piece is about", "hook": "first line that stops the scroll (<= 100 chars)", "outline": ["3-5 beats"], "hashtags": ["3-6 without #"], "visualBrief": "what the image/video should show", "titleIdeas": ["3 options"]}
Follow the brand voice and the must-avoid list literally. Never invent product claims, prices, or statistics that are not in the brief.`;

const WRITE_SYSTEM = `You write social copy for a brand. Output JSON only:
{"title": "<= 60 chars", "body": "the post body, plain text, paragraphs separated by blank lines", "cta": "one short call to action or empty string"}
Rules: write in the requested language; keep the brand voice; use the plan's hook as the first line; no hashtags inside body (they are added separately); no emojis unless the brand voice asks for them; never claim anything not in the brief.`;

const REWRITE_SYSTEM = `You fix social copy that tripped a vocabulary gate. Output JSON only: {"title": "...", "body": "...", "cta": "..."}.
Replace every flagged term with on-brand phrasing that keeps the meaning; do not add new claims; keep length similar.`;

async function planStage(brief, deps, cost) {
  const user = `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nReturn the plan JSON.`;
  const r = await callJson(deps, { system: PLAN_SYSTEM, user, maxTokens: 800 }, cost);
  const plan = r.parsed || {};
  return {
    plan: {
      angle: plan.angle || brief.topic || '',
      hook: plan.hook || '',
      outline: Array.isArray(plan.outline) ? plan.outline : [],
      hashtags: Array.isArray(plan.hashtags) ? plan.hashtags.map((h) => String(h).replace(/^#/, '')) : [],
      visualBrief: plan.visualBrief || '',
      titleIdeas: Array.isArray(plan.titleIdeas) ? plan.titleIdeas : [],
    },
    cost: r.cost,
  };
}

async function writeStage(brief, plan, locale, deps, cost) {
  const user = `LANGUAGE: ${locale}\nBRAND VOICE: ${brief.brandVoice || 'concise, warm, confident'}\nMUST AVOID: ${(brief.mustAvoid || []).join(', ') || '(none)'}\nBRIEF:\n${JSON.stringify(brief, null, 2)}\nPLAN:\n${JSON.stringify(plan, null, 2)}\n\nReturn the copy JSON.`;
  const r = await callJson(deps, { system: WRITE_SYSTEM, user, maxTokens: 1000 }, cost);
  const c = r.parsed || {};
  return { copy: { title: c.title || plan.titleIdeas[0] || '', body: c.body || plan.hook || '', cta: c.cta || brief.cta || '' }, cost: r.cost };
}

async function rewriteStage(copy, hits, locale, brief, deps, cost) {
  const user = `LANGUAGE: ${locale}\nFLAGGED TERMS: ${hits.map((h) => h.term).join(', ')}\nBRAND VOICE: ${brief.brandVoice || ''}\nCOPY:\n${JSON.stringify(copy, null, 2)}\n\nReturn the fixed copy JSON.`;
  const r = await callJson(deps, { system: REWRITE_SYSTEM, user, maxTokens: 1000, temperature: 0.4 }, cost);
  const c = r.parsed || {};
  return { copy: { title: c.title || copy.title, body: c.body || copy.body, cta: c.cta != null ? c.cta : copy.cta }, cost: r.cost };
}

async function visualStage(plan, assets, brief, deps) {
  const has = (assets.imageUrls && assets.imageUrls.length) || assets.videoUrl;
  if (has || typeof deps.imageGen !== 'function') return { assets, generated: null };
  const prompt = [plan.visualBrief || plan.angle, brief.visualStyle || '', 'no text in the image'].filter(Boolean).join('. ');
  try {
    const img = await deps.imageGen({ prompt, aspectRatio: brief.aspectRatio || '1:1' });
    if (img && img.url) return { assets: { ...assets, imageUrls: [img.url] }, generated: { url: img.url, prompt } };
  } catch (e) {
    deps.logger && deps.logger.warn && deps.logger.warn(`[pipeline] imageGen failed: ${e.message}`);
  }
  return { assets, generated: null };
}

// ------------------------------------------------------------------- main ---

/**
 * @param {object} input
 * @param {object} input.brief      { topic, goal, audience, keyMessages[], cta, link, brandVoice, mustAvoid[], visualStyle, sourceRef }
 * @param {string[]} input.platforms
 * @param {string[]} [input.locales=['en']]
 * @param {object} [input.assets]   { imageUrls[], videoUrl, coverUrl }
 * @param {object} [input.lexicon]  { banned[], patterns[] }  — or pass deps.gate
 * @param {number} [input.maxGateRetries=1]
 * @param {object} deps             { llm, imageGen?, gate?, logger? }
 */
async function runContentPipeline(input = {}, deps = {}) {
  const brief = input.brief || {};
  if (!brief.topic && !brief.keyMessages) throw new Error('pipeline: brief.topic or brief.keyMessages is required');
  const platforms = (input.platforms || []).filter((id) => getPlatform(id));
  if (!platforms.length) throw new Error('pipeline: at least one supported platform is required');
  const locales = input.locales && input.locales.length ? input.locales : ['en'];
  const gate = deps.gate || createLexiconGate(input.lexicon || {});
  const maxRetries = input.maxGateRetries == null ? 1 : input.maxGateRetries;
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};

  let cost = { inputTokens: 0, outputTokens: 0, usdCents: 0, calls: 0 };

  emit('progress', { step: 'plan' });
  const planned = await planStage(brief, deps, cost);
  cost = planned.cost;
  const plan = planned.plan;

  emit('progress', { step: 'visual' });
  const vis = await visualStage(plan, input.assets || {}, brief, deps);
  const assets = vis.assets;

  const variants = [];
  const copies = {};
  for (const locale of locales) {
    emit('progress', { step: 'write', locale });
    const w = await writeStage(brief, plan, locale, deps, cost);
    cost = w.cost;
    let copy = w.copy;

    for (const platformId of platforms) {
      const p = getPlatform(platformId);
      let attempt = 0;
      let variant;
      let gateResult;
      for (;;) {
        variant = adaptForPlatform(p.id, {
          title: copy.title,
          body: copy.body,
          cta: copy.cta,
          hashtags: plan.hashtags,
          link: brief.link || null,
          imageUrls: assets.imageUrls || [],
          videoUrl: assets.videoUrl || null,
          coverUrl: assets.coverUrl || null,
          locale,
        }, { hashtagStyle: input.hashtagStyle });
        gateResult = gate(variantText(variant));
        if (gateResult.ok || attempt >= maxRetries) break;
        attempt++;
        emit('progress', { step: 'rewrite', platform: p.id, locale, hits: gateResult.hits.map((h) => h.term) });
        const rw = await rewriteStage(copy, gateResult.hits, locale, brief, deps, cost);
        cost = rw.cost;
        copy = rw.copy;
      }
      variants.push({ ...variant, locale, gate: { ok: gateResult.ok, hits: gateResult.hits, rewrites: attempt } });
    }
    copies[locale] = copy;
  }

  const blocked = variants.filter((v) => !v.gate.ok);
  emit('progress', { step: 'complete', variants: variants.length, blocked: blocked.length });
  return {
    plan,
    copies,
    assets,
    generatedVisual: vis.generated,
    variants,
    blocked: blocked.map((v) => ({ platform: v.platform, locale: v.locale, hits: v.gate.hits })),
    cost,
  };
}

module.exports = { runContentPipeline, createLexiconGate, extractJson, _internals: { planStage, writeStage, rewriteStage, visualStage, variantText } };
