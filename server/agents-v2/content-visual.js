/**
 * Content-Visual Agent — generates images for social/blog content.
 *
 * Uses Volcengine Ark (Doubao Seedream) by default. Extensible to other
 * providers by checking which env var is set.
 *
 * Two modes:
 *   - direct:   caller-provided prompt is sent as-is to the image API
 *   - enrich:   (default) Claude first expands a short brief into a rich
 *               visual prompt with camera/lighting/style detail, then
 *               sends to the image API
 *
 * Output: URL of the generated image + final prompt used + size.
 *
 * NOTE: Generated URLs are typically time-limited by the provider (Volcengine
 * URLs expire in a few hours). For persistent storage, users should download
 * or have the Publisher agent pull the bytes when scheduling.
 */

const fetch = require('../proxy-fetch');
const llm = require('../llm');

const VOLCENGINE_ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_VOLCENGINE_MODEL = process.env.VOLCENGINE_IMAGE_MODEL || 'doubao-seedream-5-0-260128';

const ENRICH_SYSTEM_PROMPT = `You are a visual art director. Given a short brief + brand context, write a rich, detailed image-generation prompt.

Rules:
- Be specific about subject, composition, camera angle, lighting, color palette, texture, style
- Match platform conventions: Instagram = clean + aspirational; Twitter = punchy + attention-grabbing; Blog = editorial-quality
- Avoid brand logos / copyrighted characters / real people by name
- Keep it under 200 words; models lose focus beyond that
- Output ONLY the prompt, no preamble`;

async function expandPrompt(brief, { brandVoice, aspect } = {}) {
  const msg = `Brief: ${brief}
${brandVoice ? `Brand tone: ${(brandVoice.tone_words || []).join(', ')}` : ''}
${aspect ? `Aspect/use: ${aspect}` : ''}

Write the detailed image prompt.`;

  const res = await llm.complete({
    messages: [{ role: 'user', content: msg }],
    system: ENRICH_SYSTEM_PROMPT,
    maxTokens: 400,
    temperature: 0.6,
  });
  return { prompt: (res.text || '').trim(), cost: res.usage };
}

// Volcengine accepts lowercase '2k' or '3k' (or explicit WxH). Normalize
// our preferred 2K / 3K input to the lowercase form the API wants.
function normalizeSize(size) {
  if (!size) return '2k';
  if (/^\d+x\d+$/.test(size)) return size;
  const s = String(size).toLowerCase();
  if (s === '2k' || s === '3k') return s;
  // Map legacy / convenience tokens to supported values
  if (s === '1k') return '2k';
  if (s === '4k') return '3k';
  return '2k';
}

async function callVolcengine({ prompt, size = '2k', watermark = false }) {
  const key = process.env.VOLCENGINE_ARK_API_KEY;
  if (!key) throw new Error('VOLCENGINE_ARK_API_KEY not configured');

  const res = await fetch(VOLCENGINE_ARK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: DEFAULT_VOLCENGINE_MODEL,
      prompt,
      sequential_image_generation: 'disabled',
      response_format: 'url',
      size: normalizeSize(size),
      stream: false,
      watermark,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Volcengine Ark ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // API shape is OpenAI-compatible: { data: [{ url: '...' }] }
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('Volcengine Ark returned no image URL: ' + JSON.stringify(data).slice(0, 200));
  return { url, raw: data };
}

module.exports = {
  id: 'content-visual',
  name: 'Visual Content',
  description: 'Generate images from a brief. Uses Volcengine Doubao Seedream; can optionally enrich a short brief into a detailed prompt via Claude first.',
  version: '1.0.0',
  capabilities: ['generate.image'],

  inputSchema: {
    type: 'object',
    required: ['brief'],
    properties: {
      brief: { type: 'string', description: 'What you want depicted' },
      mode: { type: 'string', enum: ['direct', 'enrich'], default: 'enrich' },
      size: { type: 'string', enum: ['2k', '3k'], default: '2k', description: 'Volcengine Doubao supports 2k or 3k (or explicit WxH)' },
      brand_voice: {
        type: 'object',
        properties: {
          tone_words: { type: 'array', items: { type: 'string' } },
        },
      },
      aspect: { type: 'string', description: 'e.g. "Instagram post", "Twitter card", "blog hero"' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      prompt: { type: 'string', description: 'Final prompt sent to the image model' },
      original_brief: { type: 'string' },
      size: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  },

  costEstimate(input) {
    // Volcengine Doubao Seedream: ~¢4 for 2k, ~¢8 for 3k (rough approximation).
    // Add ~¢2 if enrichment is on (one Claude call).
    const sz = (input?.size || '2k').toLowerCase();
    const base = sz === '3k' ? 8 : 4;
    const enrich = (input?.mode === 'enrich') ? 2 : 0;
    return { usdCents: base + enrich, tokens: enrich * 1000 };
  },

  async run(input, ctx) {
    if (!input?.brief) throw new Error('brief is required');
    if (!process.env.VOLCENGINE_ARK_API_KEY) {
      throw new Error('Image provider not configured. Set VOLCENGINE_ARK_API_KEY.');
    }

    const mode = input.mode || 'enrich';
    let prompt = input.brief;
    let enrichmentCost = null;

    if (mode === 'enrich' && llm.isConfigured()) {
      ctx.emit('progress', { step: 'enriching', message: 'Expanding brief into detailed image prompt via Claude...' });
      try {
        const r = await expandPrompt(input.brief, {
          brandVoice: input.brand_voice,
          aspect: input.aspect,
        });
        if (r.prompt) prompt = r.prompt;
        enrichmentCost = r.cost;
        ctx.emit('progress', { step: 'enriched', message: `Prompt expanded (${prompt.length} chars)` });
      } catch (e) {
        ctx.emit('progress', { step: 'enrich-fallback', message: `Enrichment failed (${e.message}); using raw brief` });
      }
    }

    const sizeToUse = (input.size || '2k').toLowerCase();
    ctx.emit('progress', { step: 'generating', message: 'Calling Doubao Seedream...' });
    const { url } = await callVolcengine({ prompt, size: sizeToUse, watermark: false });

    ctx.emit('progress', { step: 'complete', message: 'Image ready' });

    const imageCostCents = sizeToUse === '3k' ? 8 : 4;
    return {
      url,
      prompt,
      original_brief: input.brief,
      size: sizeToUse,
      provider: 'volcengine-ark',
      model: DEFAULT_VOLCENGINE_MODEL,
      cost: {
        inputTokens: enrichmentCost?.inputTokens || 0,
        outputTokens: enrichmentCost?.outputTokens || 0,
        usdCents: (enrichmentCost?.usdCents || 0) + imageCostCents,
      },
    };
  },
};
