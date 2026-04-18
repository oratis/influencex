/**
 * Review Miner Agent — given a product name (ours or a competitor's) plus
 * optional raw review text, extracts:
 *   - Top praise themes (what users love)
 *   - Top pain-point themes (what users hate)
 *   - Feature requests
 *   - Quotable testimonials (good for landing pages)
 *   - Differentiation signals
 *
 * v1 accepts either a product name (LLM uses its training knowledge) or
 * raw reviews pasted in (processes directly). v2 can pull from G2/App
 * Store/Trustpilot/Google Business APIs.
 */

const llm = require('../llm');
const { safeFetch } = require('../web/web-fetch');

const SYSTEM_PROMPT = `You are a voice-of-customer analyst. Given product info (and optionally raw reviews), extract structured insights.

Rules:
- Only claim a theme when there's clear evidence (either in the pasted reviews or strong general knowledge of the product)
- For pain points: be specific ("loading times >30s on imports" beats "slow")
- Quotable testimonials must be plausible user voice, not marketing-speak; keep them short (≤20 words) and attribute only if reviewer name is in the source
- If working from training knowledge alone, say so in 'notes' and flag confidence
- Feature requests should be actionable, not aspirational

Call publish_review_insights.`;

const reviewTool = {
  name: 'publish_review_insights',
  description: 'Emit the structured review analysis.',
  input_schema: {
    type: 'object',
    required: ['praise_themes', 'pain_points'],
    properties: {
      praise_themes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme: { type: 'string' },
            evidence_frequency: { type: 'string', enum: ['very common', 'common', 'occasional'] },
            example: { type: 'string' },
          },
        },
      },
      pain_points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme: { type: 'string' },
            evidence_frequency: { type: 'string', enum: ['very common', 'common', 'occasional'] },
            example: { type: 'string' },
            suggested_response: { type: 'string' },
          },
        },
      },
      feature_requests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            request: { type: 'string' },
            user_motivation: { type: 'string' },
          },
        },
      },
      quotable_testimonials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: { type: 'string' },
            attribution: { type: 'string' },
            use_case: { type: 'string', description: 'Where in marketing this would fit: hero / social proof / feature page / etc' },
          },
        },
      },
      overall_sentiment: { type: 'string', enum: ['very positive', 'positive', 'mixed', 'negative', 'very negative'] },
      differentiation_signals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Things uniquely praised (if it\'s ours) or gaps vs competitors (if it\'s not)',
      },
      notes: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
  },
};

module.exports = {
  id: 'review-miner',
  name: 'Review Miner',
  description: 'Extract praise, pain points, feature requests, and testimonial-ready quotes from product reviews. Works with either raw review text or just a product name.',
  version: '1.0.0',
  capabilities: ['reviews.mine'],

  inputSchema: {
    type: 'object',
    required: ['product'],
    properties: {
      product: { type: 'string', description: 'Product name (ours or competitor)' },
      raw_reviews: { type: 'string', description: 'Optional: paste review text to analyze. Max ~30k characters.' },
      scrape_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: public review pages to fetch + mine (Trustpilot, Capterra, App Store RSS, etc). Max 5 URLs.',
      },
      audience_context: { type: 'string' },
    },
  },

  outputSchema: reviewTool.input_schema,

  costEstimate(input) {
    // If raw_reviews provided, cost scales with length. Otherwise small.
    const chars = (input?.raw_reviews || '').length;
    const tokens = Math.ceil(chars / 4) + 1500;
    return { tokens, usdCents: Math.max(4, Math.round(tokens / 1000 * 4)) };
  },

  async run(input, ctx) {
    if (!input?.product) throw new Error('product is required');
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    // Optionally scrape public review URLs. Each URL is fetched safely,
    // text extracted, and appended to the corpus we hand to Claude.
    const scraped = [];
    if (Array.isArray(input.scrape_urls) && input.scrape_urls.length) {
      const urls = input.scrape_urls.slice(0, 5);
      ctx.emit('progress', { step: 'scraping', message: `Fetching ${urls.length} review page(s)...` });
      for (const url of urls) {
        try {
          const r = await safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20000 });
          scraped.push({ url, title: r.title, text: r.text });
          ctx.emit('progress', { step: 'scraped', message: `  ✓ ${url}: ${r.text?.length || 0} chars` });
        } catch (e) {
          ctx.emit('progress', { step: 'scrape-fail', message: `  ✗ ${url}: ${e.message}` });
        }
      }
    }

    const combinedRaw = [
      input.raw_reviews || '',
      ...scraped.map(s => `--- FROM ${s.url} (${s.title || ''}) ---\n${s.text}`),
    ].filter(Boolean).join('\n\n');

    const hasData = !!combinedRaw.trim();
    ctx.emit('progress', {
      step: 'analyzing',
      message: hasData
        ? `Mining ${combinedRaw.length} characters of review text for "${input.product}"...`
        : `Synthesizing review patterns for "${input.product}" from model knowledge...`,
    });

    const trimmed = combinedRaw.slice(0, 30000);
    const userMessage = `Product: ${input.product}
${input.audience_context ? `Audience: ${input.audience_context}` : ''}
${hasData ? `\nRaw review excerpts (analyze these as the primary source):\n---\n${trimmed}\n---` : '(No raw reviews — work from model knowledge, flag confidence)'}

Extract insights. Call publish_review_insights.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [reviewTool],
      maxTokens: 4000,
      temperature: 0.3,
      provider: process.env.REVIEW_LLM_PROVIDER,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_review_insights');
    if (!toolUse) throw new Error('Review-Miner failed to produce structured output');

    ctx.emit('progress', {
      step: 'complete',
      message: `${toolUse.input.praise_themes?.length || 0} praise themes, ${toolUse.input.pain_points?.length || 0} pain points, ${toolUse.input.quotable_testimonials?.length || 0} quotes`,
    });

    return {
      ...toolUse.input,
      sources: { scraped_urls: scraped.map(s => ({ url: s.url, title: s.title })) },
      cost: res.usage,
    };
  },
};
