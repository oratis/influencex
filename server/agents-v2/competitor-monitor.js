/**
 * Competitor Monitor Agent — given a list of competitor names/URLs, produces
 * a current snapshot of each:
 *   - Positioning (tagline, ICP, pricing hints)
 *   - Recent moves (product launches, pricing changes, campaigns — if known
 *     to the model)
 *   - Strengths + gaps
 *   - Suggested angles for us to differentiate
 *
 * v1 relies on the model's training data; it does NOT crawl live sites.
 * Future v2 will hook into a web-fetch tool + diff against stored snapshots
 * to surface real changes over time.
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a competitive-intelligence analyst. Given a list of competitors, produce a structured snapshot of each.

Rules:
- For each competitor: be specific about positioning, ICP, pricing signals, and what they're uniquely good at
- "Recent moves" should be flagged '(model knowledge, verify)' — you're working from training data, not live web
- Gaps = specific opportunities for us to differentiate, not generic "better UX" platitudes
- Tag your confidence: high (well-known brand) / medium / low
- If a competitor is unfamiliar, say so and explain what you inferred from the name

Call publish_competitor_snapshot.`;

const compTool = {
  name: 'publish_competitor_snapshot',
  description: 'Emit the structured competitor analysis.',
  input_schema: {
    type: 'object',
    required: ['competitors', 'our_differentiation_angles'],
    properties: {
      competitors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            positioning: { type: 'string' },
            icp: { type: 'string' },
            pricing_signal: { type: 'string', description: 'e.g. "starts at $49/mo", "enterprise only", "freemium w/ usage caps"' },
            strengths: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } },
            recent_moves: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
      our_differentiation_angles: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 specific angles we could take to stand out',
      },
      themes_across_market: {
        type: 'array',
        items: { type: 'string' },
        description: 'Patterns across multiple competitors — e.g. everyone moving to usage-based pricing',
      },
    },
  },
};

module.exports = {
  id: 'competitor-monitor',
  name: 'Competitor Monitor',
  description: 'Snapshot one or more competitors: positioning, ICP, pricing, strengths, gaps, and angles we can take to differentiate.',
  version: '1.0.0',
  capabilities: ['competitor.snapshot'],

  inputSchema: {
    type: 'object',
    required: ['competitors'],
    properties: {
      competitors: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of competitor names or URLs',
        minItems: 1,
      },
      our_positioning: { type: 'string', description: 'Short description of our own product for context' },
      category: { type: 'string', description: 'e.g. "AI content marketing", "project management"' },
    },
  },

  outputSchema: compTool.input_schema,

  costEstimate(input) {
    const n = input?.competitors?.length || 1;
    return { tokens: 500 + n * 400, usdCents: Math.max(4, n * 3) };
  },

  async run(input, ctx) {
    if (!Array.isArray(input?.competitors) || input.competitors.length === 0) {
      throw new Error('competitors[] is required');
    }
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    ctx.emit('progress', {
      step: 'analyzing',
      message: `Analyzing ${input.competitors.length} competitor${input.competitors.length > 1 ? 's' : ''}...`,
    });

    const userMessage = `Competitors: ${input.competitors.join(', ')}
${input.our_positioning ? `Our positioning: ${input.our_positioning}` : ''}
${input.category ? `Category: ${input.category}` : ''}

Produce a competitive snapshot. Call publish_competitor_snapshot.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [compTool],
      maxTokens: 4000,
      temperature: 0.5,
      provider: process.env.COMPETITOR_LLM_PROVIDER,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_competitor_snapshot');
    if (!toolUse) throw new Error('Competitor-Monitor failed to produce structured output');

    ctx.emit('progress', {
      step: 'complete',
      message: `${toolUse.input.competitors?.length || 0} competitor profiles`,
    });

    return { ...toolUse.input, cost: res.usage };
  },
};
