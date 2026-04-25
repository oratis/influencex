/**
 * Content-Text Agent — produces text content for any channel, adapted to
 * the brand voice.
 *
 * Output format depends on `input.format`:
 *   - twitter:      single tweet or thread (2–10 tweets)
 *   - linkedin:     medium-form LinkedIn post (150-300 words)
 *   - blog:         full blog post with title + intro + body + CTA
 *   - email:        subject + body
 *   - caption:      short social caption (<150 chars) with hashtags
 *   - youtube-short: hook + body + CTA for a 60s video script
 */

const llm = require('../llm');
const bvSearch = require('../brand-voice-search');
const { usePostgres } = require('../database');

const SYSTEM_PROMPT_BASE = `You are a senior content writer. Your job: produce ONE piece of content that is tailored to the specified format, audience, and brand voice.

Rules:
1. Follow the brand voice exactly — tone words matter
2. No generic AI-ese ("In today's fast-paced world...", "Let's dive in", etc)
3. Lead with something concrete (a number, observation, or specific claim)
4. End with one clear call-to-action or takeaway
5. Match format conventions:
   - Twitter: ≤280 chars per tweet, plain text, hooks in first tweet
   - LinkedIn: first line is the hook (people scroll); short paragraphs; one emoji max
   - Blog: H1 + short opener + 3-5 H2 sections + conclusion
   - Email: personal tone, subject <60 chars, body <250 words
   - Caption: punchy, 3-5 relevant hashtags
   - YouTube-short: hook ≤5s, body, CTA
6. If brand voice is missing, default to professional-friendly

Emit output via the write_content tool.`;

const writeTool = {
  name: 'write_content',
  description: 'Emit the final content piece.',
  input_schema: {
    type: 'object',
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', description: 'Headline / subject / thread-opener — the hook' },
      body: { type: 'string', description: 'The full content body' },
      hashtags: { type: 'array', items: { type: 'string' }, description: 'For social formats' },
      cta: { type: 'string', description: 'Primary call-to-action' },
      format: { type: 'string' },
      word_count: { type: 'number' },
      reasoning: { type: 'string', description: 'Brief explanation of creative choices' },
    },
  },
};

const FORMAT_HINTS = {
  twitter: 'Produce either a single tweet (<280 chars) or a thread. For threads, separate tweets with "\\n---\\n".',
  linkedin: 'Produce one LinkedIn post, 150–300 words. First line = the hook. Short paragraphs.',
  blog: 'Produce a blog post (~600–1200 words). Start with an H1. Use H2s for sections.',
  email: 'Produce email: subject line as `title`, body as `body`. Body ≤250 words. Warm + personal.',
  caption: 'Produce a short caption (<150 chars body) + 3-5 hashtags.',
  'youtube-short': 'Produce a 60s video script: hook (≤5s), body, CTA. `body` is the full script.',
};

module.exports = {
  id: 'content-text',
  name: 'Content Writer',
  description: 'Write a piece of text content (tweet, LinkedIn post, blog, email, caption, YouTube short) in your brand voice.',
  version: '1.0.0',
  capabilities: ['write.twitter', 'write.linkedin', 'write.blog', 'write.email', 'write.caption', 'write.youtube-short'],

  inputSchema: {
    type: 'object',
    required: ['format', 'brief'],
    properties: {
      format: { type: 'string', enum: ['twitter', 'linkedin', 'blog', 'email', 'caption', 'youtube-short'] },
      brief: { type: 'string', description: 'What this piece should cover' },
      tier: {
        type: 'string',
        enum: ['fast', 'quality'],
        default: 'quality',
        description: 'fast = Claude Haiku 4.5 or Gemini Flash (~10% cost, 3x faster, fine for tweets/captions). quality = Claude Sonnet 4.5 (best for blogs, emails, LinkedIn).',
      },
      brand_voice: {
        type: 'object',
        properties: {
          tone_words: { type: 'array', items: { type: 'string' } },
          do_examples: { type: 'array', items: { type: 'string' } },
          dont_examples: { type: 'array', items: { type: 'string' } },
        },
      },
      audience: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      cta: { type: 'string' },
    },
  },

  outputSchema: writeTool.input_schema,

  costEstimate(input) {
    // Blog pieces are expensive; captions cheap.
    // Fast tier (Haiku/Flash) costs ~10% of quality tier.
    const baseByFormat = {
      blog: 40,
      linkedin: 18,
      'youtube-short': 12,
      email: 15,
      twitter: 10,
      caption: 8,
    };
    const base = baseByFormat[input.format] || 20;
    const multiplier = input?.tier === 'fast' ? 0.1 : 1;
    return { tokens: 2000, usdCents: Math.max(1, Math.round(base * multiplier)) };
  },

  async run(input, ctx) {
    ctx.emit('progress', { step: 'writing', message: `Writing ${input.format}: "${(input.brief || '').slice(0, 60)}..."` });

    // Brand-voice resolution: if caller didn't pass one explicitly, try to
    // find the closest saved voice in this workspace via embedding similarity.
    // Falls back silently to "no brand voice" when:
    //   - no workspaceId / db in ctx
    //   - workspace has no voices yet
    //   - none are similar enough to the brief (< 0.4 cosine)
    let brandVoice = input.brand_voice;
    if (!brandVoice && ctx?.workspaceId && ctx?.db && input.brief) {
      try {
        const found = await bvSearch.findBestBrandVoice({
          workspaceId: ctx.workspaceId,
          brief: input.brief,
          db: ctx.db,
          usePostgres,
        });
        if (found) {
          brandVoice = found;
          ctx.emit('progress', { step: 'brand_voice', message: `Auto-selected brand voice "${found.name}" based on brief.` });
        }
      } catch (e) {
        ctx.logger?.warn?.('brand-voice auto-select failed:', e.message);
      }
    }

    const brandVoiceBlock = brandVoice ? `
Brand voice:
- Tone: ${(brandVoice.tone_words || []).join(', ') || 'professional-friendly'}
${brandVoice.do_examples?.length ? '- Good examples:\n  ' + brandVoice.do_examples.map(e => `• ${e}`).join('\n  ') : ''}
${brandVoice.dont_examples?.length ? '- Avoid:\n  ' + brandVoice.dont_examples.map(e => `• ${e}`).join('\n  ') : ''}
` : '';

    const userMessage = `Format: ${input.format}
${FORMAT_HINTS[input.format] || ''}

${input.audience ? `Audience: ${input.audience}` : ''}
${brandVoiceBlock}
${input.keywords?.length ? `Target keywords: ${input.keywords.join(', ')}` : ''}
${input.cta ? `Required CTA: ${input.cta}` : ''}

Brief:
${input.brief}

Write one polished piece. Call write_content.`;

    // Tier → provider+model mapping. `fast` picks the cheapest strong option
    // available; `quality` (default) uses the flagship Claude Sonnet.
    // Env vars CONTENT_TEXT_FAST_MODEL / CONTENT_TEXT_QUALITY_MODEL override.
    const tier = input.tier || 'quality';
    let provider, model;
    if (tier === 'fast') {
      if (process.env.ANTHROPIC_API_KEY) {
        provider = 'anthropic';
        model = process.env.CONTENT_TEXT_FAST_MODEL || 'claude-haiku-4-5';
      } else if (process.env.GOOGLE_AI_API_KEY) {
        provider = 'google';
        model = process.env.CONTENT_TEXT_FAST_MODEL || 'gemini-2.5-flash';
      }
    } else {
      // 'quality' — use whatever the default provider is; no explicit model
      // so llm defaults pick (claude-sonnet-4-5 typically).
      model = process.env.CONTENT_TEXT_QUALITY_MODEL;
    }

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT_BASE,
      tools: [writeTool],
      maxTokens: input.format === 'blog' ? 4000 : 2000,
      temperature: 0.7,
      provider,
      model,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'write_content');
    if (!toolUse) {
      throw new Error('Content agent failed to produce structured output: ' + res.text.slice(0, 200));
    }

    ctx.emit('progress', { step: 'complete', message: `${toolUse.input.word_count || '?'} words written` });
    return { ...toolUse.input, cost: res.usage };
  },
};
