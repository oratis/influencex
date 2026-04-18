/**
 * SEO Agent — given a topic or URL, produces:
 *   - Primary keyword + 5-10 supporting long-tail keywords (with search intent)
 *   - On-page SEO brief: title tag, meta description, H1/H2 outline, internal-linking suggestions
 *   - Backlink + authority-building angles (2-4 concrete outreach ideas)
 *
 * v1 is LLM-only (no SerpAPI / Ahrefs yet). Claude or Gemini Flash are both
 * strong for this kind of structured extraction.
 */

const llm = require('../llm');
const serpapi = require('../web/serpapi');

const SYSTEM_PROMPT = `You are a senior SEO strategist. Given a topic or URL, produce a complete SEO brief.

Rules:
- Be specific. Avoid "write great content" truisms.
- For keywords: include search intent (informational / commercial / transactional / navigational) and a difficulty estimate (low / medium / high)
- For on-page: be concrete (actual title tag text, actual meta description text, outline with H2 headings the reader will actually see)
- For backlinks: list specific outreach angles that would plausibly land links (e.g. "Pitch quote to HubSpot's content marketing guide on X")
- Do NOT invent data (search volume numbers, specific Ahrefs/Moz rankings) — mark those as estimates

Call publish_seo_brief.`;

const seoTool = {
  name: 'publish_seo_brief',
  description: 'Emit the SEO brief.',
  input_schema: {
    type: 'object',
    required: ['primary_keyword', 'secondary_keywords', 'on_page', 'backlink_angles'],
    properties: {
      primary_keyword: { type: 'string' },
      secondary_keywords: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            intent: { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] },
            difficulty: { type: 'string', enum: ['low', 'medium', 'high'] },
            rationale: { type: 'string' },
          },
        },
      },
      on_page: {
        type: 'object',
        properties: {
          title_tag: { type: 'string', description: '≤60 chars recommended' },
          meta_description: { type: 'string', description: '≤155 chars recommended' },
          h1: { type: 'string' },
          outline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                h2: { type: 'string' },
                notes: { type: 'string' },
              },
            },
          },
          internal_linking_suggestions: { type: 'array', items: { type: 'string' } },
          word_count_target: { type: 'number' },
        },
      },
      backlink_angles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            angle: { type: 'string' },
            target_site_type: { type: 'string' },
            outreach_note: { type: 'string' },
          },
        },
      },
      competitor_snapshot: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            competitor: { type: 'string' },
            gap: { type: 'string' },
          },
        },
        description: 'Optional — if you know which sites currently rank, summarize what they cover + where you can differentiate',
      },
    },
  },
};

module.exports = {
  id: 'seo',
  name: 'SEO Strategist',
  description: 'Given a topic or existing URL, produce a complete SEO brief: primary + long-tail keywords, on-page spec (title/meta/outline), and backlink-outreach angles.',
  version: '1.0.0',
  capabilities: ['seo.brief'],

  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string', description: 'Either a topic ("AI content marketing for startups") or a URL to optimize' },
      geo: { type: 'string', description: 'Optional geo/language hint (e.g. "en-US", "zh-CN")' },
      audience: { type: 'string' },
    },
  },

  outputSchema: seoTool.input_schema,

  costEstimate() {
    // ~2-3k total tokens with Sonnet. Gemini Flash runs this at ~10x cheaper.
    return { tokens: 2500, usdCents: 6 };
  },

  async run(input, ctx) {
    if (!input?.topic) throw new Error('topic is required');
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    ctx.emit('progress', { step: 'analyzing', message: `Researching SEO for "${input.topic.slice(0, 60)}"...` });

    // Optional: enrich with real SERP data when SerpAPI is configured.
    // This gives the model actual top-ranking URLs + snippets to work from
    // instead of guessing from training data.
    let serpBlock = '';
    let serpSources = null;
    if (serpapi.isConfigured()) {
      ctx.emit('progress', { step: 'serp-fetch', message: 'Pulling live Google SERP via SerpAPI...' });
      try {
        const [serp, kwIdeas] = await Promise.all([
          serpapi.search({ query: input.topic, limit: 8, gl: input.geo?.split('-')[1] || 'us' }),
          serpapi.keywordIdeas({ seed: input.topic }),
        ]);
        if (serp.configured && serp.organic?.length) {
          serpBlock = `\n\nLive SERP data for "${input.topic}" (top ${serp.organic.length} organic results):\n` +
            serp.organic.map(r => `  ${r.position}. ${r.title}\n     ${r.url}\n     ${r.snippet || ''}`).join('\n') +
            (serp.related_questions?.length ? `\n\nPeople also ask: ${serp.related_questions.join(' | ')}` : '') +
            (kwIdeas.suggestions?.length ? `\n\nAutocomplete suggestions: ${kwIdeas.suggestions.slice(0, 10).join(', ')}` : '');
          serpSources = serp.organic.map(r => ({ title: r.title, url: r.url }));
          ctx.emit('progress', { step: 'serp-done', message: `Got ${serp.organic.length} organic results + ${kwIdeas.suggestions?.length || 0} suggestions` });
        }
      } catch (e) {
        ctx.emit('progress', { step: 'serp-failed', message: `SerpAPI failed: ${e.message}. Falling back to LLM-only.` });
      }
    }

    const userMessage = `Topic or URL: ${input.topic}
${input.geo ? `Geo/language: ${input.geo}` : ''}
${input.audience ? `Target audience: ${input.audience}` : ''}${serpBlock}

Produce a complete SEO brief. ${serpBlock ? 'Ground your analysis in the live SERP data above — cite which ranking competitors you\'re analyzing.' : ''} Call publish_seo_brief.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [seoTool],
      maxTokens: 3000,
      temperature: 0.4,
      // Gemini Flash is great for structured extraction; opt in via env.
      provider: process.env.SEO_LLM_PROVIDER,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_seo_brief');
    if (!toolUse) throw new Error('SEO agent failed to produce structured output: ' + res.text.slice(0, 200));

    ctx.emit('progress', {
      step: 'complete',
      message: `${toolUse.input.secondary_keywords?.length || 0} keywords, ${toolUse.input.on_page?.outline?.length || 0}-section outline`,
    });

    return {
      ...toolUse.input,
      data_sources: { serpapi: !!serpSources, serp_top_urls: serpSources },
      cost: res.usage,
    };
  },
};
