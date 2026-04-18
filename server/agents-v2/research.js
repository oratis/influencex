/**
 * Research Agent — given a topic, returns:
 *   - Trending angles / hooks
 *   - Keyword ideas + search intent
 *   - Competitor content snapshot (who's ranking, what angles they use)
 *   - 3-5 content ideas ready to hand off to the Content Agent
 *
 * For v1 this is LLM-only (the model does the research from its training
 * knowledge). Future versions will add real web search + SerpAPI.
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a research analyst for content marketing. Given a topic, surface:
- The freshest angles (what's new in the last 6 months if the model knows)
- Keywords people actually search for (with intent tags: informational / commercial / navigational)
- How competitors are covering this space (strengths + gaps)
- 3-5 specific content briefs ready for a writer

Cite sources in the 'notes' field when confident; otherwise flag as '(model knowledge, unverified)'.`;

const researchTool = {
  name: 'publish_research',
  description: 'Emit the research report.',
  input_schema: {
    type: 'object',
    required: ['angles', 'keywords', 'content_ideas'],
    properties: {
      angles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hook: { type: 'string' },
            why_now: { type: 'string' },
            risk: { type: 'string' },
          },
        },
      },
      keywords: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            intent: { type: 'string', enum: ['informational', 'commercial', 'navigational', 'transactional'] },
            difficulty_estimate: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      competitor_landscape: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            competitor: { type: 'string' },
            angle: { type: 'string' },
            strength: { type: 'string' },
            gap: { type: 'string' },
          },
        },
      },
      content_ideas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            format: { type: 'string', description: 'blog-post / twitter-thread / youtube-short / linkedin-post / etc' },
            outline: { type: 'array', items: { type: 'string' } },
            target_keyword: { type: 'string' },
          },
        },
      },
      notes: { type: 'string', description: 'Caveats, source hints, confidence notes' },
    },
  },
};

module.exports = {
  id: 'research',
  name: 'Research',
  description: 'Mine trending angles, keyword ideas, competitor landscape, and content ideas for a topic.',
  version: '1.0.0',
  capabilities: ['research.topic'],

  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
      audience: { type: 'string', description: 'Optional audience context (e.g. "SaaS founders")' },
      target_channels: { type: 'array', items: { type: 'string' } },
    },
  },

  outputSchema: researchTool.input_schema,

  costEstimate() {
    return { tokens: 2500, usdCents: 28 };
  },

  async run(input, ctx) {
    ctx.emit('progress', { step: 'analyzing', message: `Researching "${input.topic}"...` });

    const userMessage = `Topic: ${input.topic}
${input.audience ? `Target audience: ${input.audience}` : ''}
${input.target_channels?.length ? `Target channels: ${input.target_channels.join(', ')}` : ''}

Produce a research report. Call publish_research.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [researchTool],
      maxTokens: 3000,
      temperature: 0.5,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_research');
    if (!toolUse) {
      throw new Error('Research agent failed to produce structured output: ' + res.text.slice(0, 200));
    }

    ctx.emit('progress', { step: 'complete', message: `${toolUse.input.content_ideas?.length || 0} content ideas generated` });
    return { ...toolUse.input, cost: res.usage };
  },
};
