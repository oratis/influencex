/**
 * Translate Agent — localize a piece of content into multiple target languages
 * in a single LLM round-trip. Preserves brand voice, respects per-format
 * length constraints (e.g. a Spanish tweet still has to fit 280 chars), and
 * keeps a user-supplied term glossary untranslated (product names, trademarks).
 *
 * Phase C commitment: we target 12+ BCP-47 languages in one call. Batch
 * translation is cheaper than N sequential calls and lets the model keep
 * voice consistent across outputs.
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a senior localization specialist fluent in 40+ languages. Your job: translate ONE source piece into several target languages so the output reads like it was written natively in each market.

Rules:
- Preserve brand voice (tone_words) and intent, not just literal meaning.
- For social formats, enforce the platform's length limit in the TARGET language (German often expands 20-30%; Japanese/Chinese compress).
- Never translate the entries in preserve_terms — they are product names or trademarks. Keep them verbatim, even if the surrounding grammar must bend.
- Adapt cultural references (US holidays, idioms) to an equivalent that lands in the target locale; note the adaptation.
- Keep hashtags appropriate: localize them if the region uses its own hashtags (e.g. Chinese social), otherwise keep the source hashtag.
- For URLs, leave them untouched.
- Emit output via the publish_translations tool. One entry per target language.`;

const translateTool = {
  name: 'publish_translations',
  description: 'Emit the batched translation results.',
  input_schema: {
    type: 'object',
    required: ['source_language', 'translations'],
    properties: {
      source_language: { type: 'string', description: 'Detected BCP-47 code of the source, e.g. "en", "en-US"' },
      translations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['language', 'content'],
          properties: {
            language: { type: 'string', description: 'BCP-47 code, e.g. "es", "zh-CN", "pt-BR"' },
            content: { type: 'string', description: 'Localized content' },
            title: { type: 'string', description: 'Localized title/headline if the source had one' },
            hashtags: { type: 'array', items: { type: 'string' }, description: 'Localized or preserved hashtags' },
            char_count: { type: 'number' },
            notes: { type: 'string', description: 'Cultural adaptations, preserved terms, or length tradeoffs' },
          },
        },
      },
    },
  },
};

const FORMAT_LIMITS = {
  twitter: '280 chars per post (hard limit — split into a thread if needed)',
  linkedin: '150-300 words',
  blog: 'no hard limit, match source length ±20%',
  email: 'subject ≤60 chars, body ≤250 words',
  caption: 'body <150 chars, 3-5 hashtags',
  'youtube-short': '60s read-aloud time (~130-150 words at typical TTS pace)',
};

module.exports = {
  id: 'translate',
  name: 'Translator',
  description: 'Localize a piece of content into multiple target languages in one pass. Keeps brand voice, respects format length limits per language, preserves a glossary of untranslatable brand terms.',
  version: '0.1.0',
  capabilities: ['translate.batch'],

  inputSchema: {
    type: 'object',
    required: ['content', 'target_languages'],
    properties: {
      content: { type: 'string', description: 'Source content to translate' },
      target_languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'BCP-47 codes, e.g. ["es", "fr", "de", "ja", "zh-CN", "pt-BR"]',
      },
      source_language: { type: 'string', description: 'BCP-47 code of the source (auto-detected if omitted)' },
      format: {
        type: 'string',
        enum: ['twitter', 'linkedin', 'blog', 'email', 'caption', 'youtube-short'],
        description: 'Platform format — informs length limits applied to each translation.',
      },
      brand_voice: {
        type: 'object',
        properties: {
          tone_words: { type: 'array', items: { type: 'string' } },
          do_examples: { type: 'array', items: { type: 'string' } },
          dont_examples: { type: 'array', items: { type: 'string' } },
        },
      },
      preserve_terms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Brand names, product names, trademarks that must NOT be translated.',
      },
      title: { type: 'string', description: 'Optional source title/headline' },
    },
  },

  outputSchema: translateTool.input_schema,

  costEstimate(input) {
    const langs = Array.isArray(input?.target_languages) ? input.target_languages.length : 3;
    const base = 200;
    const perLang = 400;
    const tokens = base + perLang * langs;
    // Haiku-class pricing estimate; quality tier doubles this. Tight for captions,
    // generous for blogs — the runtime just uses this to show a preview.
    const usdCents = Math.max(1, Math.round(tokens * 0.001));
    return { tokens, usdCents };
  },

  async run(input, ctx) {
    if (!input?.content) throw new Error('content is required');
    if (!Array.isArray(input?.target_languages) || input.target_languages.length === 0) {
      throw new Error('target_languages (non-empty array) is required');
    }
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    const langs = input.target_languages;
    ctx.emit('progress', {
      step: 'translating',
      message: `Localizing into ${langs.length} language${langs.length === 1 ? '' : 's'}: ${langs.join(', ')}`,
    });

    const voiceBlock = input.brand_voice ? `
Brand voice:
- Tone: ${(input.brand_voice.tone_words || []).join(', ') || 'neutral'}
${input.brand_voice.do_examples?.length ? '- Good examples:\n  ' + input.brand_voice.do_examples.map(e => `• ${e}`).join('\n  ') : ''}
${input.brand_voice.dont_examples?.length ? '- Avoid:\n  ' + input.brand_voice.dont_examples.map(e => `• ${e}`).join('\n  ') : ''}
` : '';

    const preserveBlock = input.preserve_terms?.length
      ? `\nPreserve verbatim (do NOT translate): ${input.preserve_terms.join(', ')}\n`
      : '';

    const formatBlock = input.format
      ? `\nFormat: ${input.format} — ${FORMAT_LIMITS[input.format] || ''}\n`
      : '';

    const userMessage = `Source ${input.source_language ? `(${input.source_language})` : '(detect automatically)'}:
${input.title ? `Title: ${input.title}\n` : ''}
${input.content}

Target languages: ${langs.join(', ')}
${formatBlock}${voiceBlock}${preserveBlock}
Call publish_translations with one entry per target language.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [translateTool],
      maxTokens: Math.min(8000, 1200 + 600 * langs.length),
      temperature: 0.4,
      provider: process.env.TRANSLATE_LLM_PROVIDER,
      model: process.env.TRANSLATE_LLM_MODEL,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_translations');
    if (!toolUse) {
      throw new Error('Translate agent failed to produce structured output: ' + (res.text || '').slice(0, 200));
    }

    const plan = toolUse.input;
    ctx.emit('progress', {
      step: 'complete',
      message: `${plan.translations?.length || 0} translations produced from ${plan.source_language || 'auto-detected source'}`,
    });

    return { ...plan, cost: res.usage };
  },
};
