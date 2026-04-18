/**
 * Strategy Agent — given a brand's description, produces:
 *   - ICP (Ideal Customer Profile): demographics, psychographics, channels
 *   - Brand voice: tone words, do/don't examples, style guide
 *   - Content pillars: 3-5 key themes
 *   - Suggested content cadence
 *
 * This is the "what should we be talking about" agent. Its output feeds the
 * Research, Content, and Discovery agents.
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a senior content marketing strategist. Given a brand description, produce a complete marketing strategy in one pass.

Be specific and actionable. Avoid generic advice. If the brand description is vague, make explicit assumptions (and state them) rather than stalling.

Output JSON matching the schema provided in the tool.`;

const strategyTool = {
  name: 'publish_strategy',
  description: 'Emit the complete strategy document.',
  input_schema: {
    type: 'object',
    required: ['icp', 'brand_voice', 'content_pillars', 'cadence'],
    properties: {
      icp: {
        type: 'object',
        properties: {
          who: { type: 'string', description: 'One-paragraph description of the target customer' },
          demographics: { type: 'object', properties: { age: { type: 'string' }, role: { type: 'string' }, income: { type: 'string' }, location: { type: 'string' } } },
          pain_points: { type: 'array', items: { type: 'string' } },
          watering_holes: { type: 'array', items: { type: 'string' }, description: 'Where they hang out online' },
        },
      },
      brand_voice: {
        type: 'object',
        properties: {
          tone_words: { type: 'array', items: { type: 'string' } },
          do_examples: { type: 'array', items: { type: 'string' } },
          dont_examples: { type: 'array', items: { type: 'string' } },
          style_guide: { type: 'string' },
        },
      },
      content_pillars: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            example_topics: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      cadence: {
        type: 'object',
        properties: {
          posts_per_week: { type: 'number' },
          channels: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
      assumptions_made: { type: 'array', items: { type: 'string' } },
    },
  },
};

module.exports = {
  id: 'strategy',
  name: 'Strategy',
  description: 'Develop an ICP, brand voice, content pillars, and posting cadence from a brand description.',
  version: '1.0.0',
  capabilities: ['strategy.build'],

  inputSchema: {
    type: 'object',
    required: ['brand_description'],
    properties: {
      brand_description: { type: 'string', description: 'What the brand does, who it serves, key differentiators' },
      existing_competitors: { type: 'array', items: { type: 'string' } },
      goals: { type: 'string' },
    },
  },

  outputSchema: strategyTool.input_schema,

  costEstimate() {
    // Roughly 800 input + 1200 output tokens with Claude Sonnet 4
    return { tokens: 2000, usdCents: 22 };
  },

  async run(input, ctx) {
    ctx.emit('progress', { step: 'analyzing', message: 'Analyzing brand description...' });

    const userMessage = `Brand description:
${input.brand_description}

${input.existing_competitors?.length ? `Competitors: ${input.existing_competitors.join(', ')}` : ''}
${input.goals ? `Goals: ${input.goals}` : ''}

Produce a complete strategy. Call publish_strategy.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [strategyTool],
      maxTokens: 3000,
      temperature: 0.4,
      // Cost tip: Gemini Flash does structured JSON extraction well at ~10%
      // the cost of Claude Sonnet. Set STRATEGY_LLM_PROVIDER=google to use it.
      provider: process.env.STRATEGY_LLM_PROVIDER,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_strategy');
    if (!toolUse) {
      throw new Error('Strategy agent failed to produce structured output: ' + res.text.slice(0, 200));
    }

    ctx.emit('progress', { step: 'complete', message: `Strategy ready: ${toolUse.input.content_pillars?.length || 0} pillars identified` });

    return {
      ...toolUse.input,
      cost: res.usage,
    };
  },
};
