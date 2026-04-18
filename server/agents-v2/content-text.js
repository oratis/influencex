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
    const baseByFormat = {
      blog: 40,
      linkedin: 18,
      'youtube-short': 12,
      email: 15,
      twitter: 10,
      caption: 8,
    };
    return { tokens: 2000, usdCents: baseByFormat[input.format] || 20 };
  },

  async run(input, ctx) {
    ctx.emit('progress', { step: 'writing', message: `Writing ${input.format}: "${(input.brief || '').slice(0, 60)}..."` });

    const brandVoiceBlock = input.brand_voice ? `
Brand voice:
- Tone: ${(input.brand_voice.tone_words || []).join(', ') || 'professional-friendly'}
${input.brand_voice.do_examples?.length ? '- Good examples:\n  ' + input.brand_voice.do_examples.map(e => `• ${e}`).join('\n  ') : ''}
${input.brand_voice.dont_examples?.length ? '- Avoid:\n  ' + input.brand_voice.dont_examples.map(e => `• ${e}`).join('\n  ') : ''}
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

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT_BASE,
      tools: [writeTool],
      maxTokens: input.format === 'blog' ? 4000 : 2000,
      temperature: 0.7,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'write_content');
    if (!toolUse) {
      throw new Error('Content agent failed to produce structured output: ' + res.text.slice(0, 200));
    }

    ctx.emit('progress', { step: 'complete', message: `${toolUse.input.word_count || '?'} words written` });
    return { ...toolUse.input, cost: res.usage };
  },
};
