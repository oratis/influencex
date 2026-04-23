/**
 * Analytics Agent — interprets aggregated workspace metrics and emits
 * actionable insights (what's working, what's underperforming, anomalies)
 * plus concrete next actions.
 *
 * This sits one layer above the `/api/analytics/*` endpoints. Those return
 * raw counts; this agent turns the counts into recommendations. v1 accepts
 * the already-aggregated payload that the client fetches anyway; v2 can
 * pull straight from the DB so the agent can be run headlessly from the
 * Conductor.
 *
 * The input is intentionally loose — any JSON-serializable metrics bundle
 * is fine. The more context we hand the model, the better the call.
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a senior growth-marketing analyst. Given a bundle of workspace metrics, your job is to surface what's actually interesting — not restate the numbers.

Rules:
- Lead with insights that change behavior. "LinkedIn posts convert 3× better than X but we only ship 1/week" beats "we have 12 LinkedIn posts"
- Call out anomalies explicitly (spikes, drops, outliers). Label each anomaly 'spike' or 'drop' and state the magnitude.
- For every insight, offer a concrete next action — specific enough to assign to someone or schedule as an agent run (e.g. "Queue 5 more LinkedIn carousels via content-visual agent before Friday")
- Quantify where the data allows. "+47% WoW" beats "growing fast"
- Flag data gaps when an insight is thin. We'd rather see "low confidence — only 8 scheduled publishes in the window" than a confidently wrong recommendation.
- Keep it tight. 3-5 insights, 3-5 recommendations. Quality over volume.

Call publish_analytics_report exactly once.`;

const analyticsTool = {
  name: 'publish_analytics_report',
  description: 'Emit the structured analytics report.',
  input_schema: {
    type: 'object',
    required: ['headline', 'insights', 'recommendations'],
    properties: {
      headline: {
        type: 'string',
        description: 'One-sentence TL;DR of the state of the workspace for the window',
      },
      window: {
        type: 'string',
        description: 'Time window this report covers, echoed for display (e.g. "last 30 days")',
      },
      insights: {
        type: 'array',
        description: '3-5 observations that change behavior',
        items: {
          type: 'object',
          required: ['title', 'detail'],
          properties: {
            title: { type: 'string', description: 'One-line headline for the insight' },
            detail: { type: 'string', description: 'The supporting numbers and reasoning' },
            category: {
              type: 'string',
              enum: ['platform', 'content', 'agent-usage', 'cost', 'pipeline', 'audience', 'other'],
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            metric_delta: {
              type: 'object',
              description: 'Optional quantified change, if the data supports it',
              properties: {
                metric: { type: 'string' },
                from: { type: 'number' },
                to: { type: 'number' },
                pct_change: { type: 'number' },
              },
            },
          },
        },
      },
      anomalies: {
        type: 'array',
        description: 'Unusual spikes or drops worth investigating',
        items: {
          type: 'object',
          required: ['kind', 'description'],
          properties: {
            kind: { type: 'string', enum: ['spike', 'drop'] },
            description: { type: 'string' },
            magnitude: { type: 'string', description: 'e.g. "3.2× baseline", "-68% WoW"' },
            likely_cause: { type: 'string' },
          },
        },
      },
      recommendations: {
        type: 'array',
        description: '3-5 concrete next actions, each owner-assignable',
        items: {
          type: 'object',
          required: ['action', 'rationale'],
          properties: {
            action: { type: 'string', description: 'Imperative phrase, e.g. "Ship 3 more LinkedIn carousels this week"' },
            rationale: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            suggested_agent: {
              type: 'string',
              description: 'If this maps to an existing v2 agent id (content-text, ads, translate, etc), name it',
            },
            effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      data_gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Things we\'d need more data on before drawing strong conclusions',
      },
    },
  },
};

module.exports = {
  id: 'analytics',
  name: 'Analytics Analyst',
  description: 'Interpret workspace analytics (platforms, agents, content, pipeline) into insights, anomalies, and ranked next actions.',
  version: '0.1.0',
  capabilities: ['analytics.interpret'],

  inputSchema: {
    type: 'object',
    required: ['metrics'],
    properties: {
      metrics: {
        type: 'object',
        description: 'Aggregated metrics payload. Any JSON shape is fine — the model reads it adaptively. Typical keys: byPlatform, byAgent, byType, funnel, costs.',
      },
      window: {
        type: 'string',
        description: 'Human-readable time window (e.g. "last 7 days", "Q1 2026"). Surfaced in the report header.',
      },
      goals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional current objectives so recommendations ladder up, e.g. ["grow signups", "reduce CPA"]',
      },
      prior_window_metrics: {
        type: 'object',
        description: 'Optional previous-period metrics for WoW / MoM comparisons',
      },
      audience_context: {
        type: 'string',
        description: 'Who the workspace targets — helps the agent judge which platforms and tactics matter',
      },
    },
  },

  outputSchema: analyticsTool.input_schema,

  costEstimate(input) {
    // Rough tokens = input size / 4 plus a fixed generation budget.
    let payloadSize = 0;
    try { payloadSize = JSON.stringify(input?.metrics || {}).length + JSON.stringify(input?.prior_window_metrics || {}).length; }
    catch { payloadSize = 2000; }
    const inTokens = Math.ceil(payloadSize / 4) + 500;
    const outTokens = 2000;
    const tokens = inTokens + outTokens;
    return { tokens, usdCents: Math.max(3, Math.round(tokens * 0.001)) };
  },

  async run(input, ctx) {
    if (!input?.metrics || typeof input.metrics !== 'object') {
      throw new Error('metrics (object) is required');
    }
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    ctx.emit('progress', {
      step: 'analyzing',
      message: `Interpreting ${input.window ? `"${input.window}" ` : ''}metrics…`,
    });

    const goalsBlock = Array.isArray(input.goals) && input.goals.length
      ? `\nCurrent goals:\n${input.goals.map(g => `- ${g}`).join('\n')}`
      : '';

    const audienceBlock = input.audience_context ? `\nAudience: ${input.audience_context}` : '';
    const windowBlock = input.window ? `\nWindow: ${input.window}` : '';

    const metricsJson = JSON.stringify(input.metrics, null, 2);
    const priorJson = input.prior_window_metrics
      ? `\n\nPrior-window metrics (for comparison):\n${JSON.stringify(input.prior_window_metrics, null, 2)}`
      : '';

    // Hard-cap payload to keep prompt size predictable. Analytics bundles can
    // balloon once per-content rows are included; we truncate and note it.
    const MAX_METRICS_CHARS = 40_000;
    let payload = metricsJson + priorJson;
    let truncated = false;
    if (payload.length > MAX_METRICS_CHARS) {
      payload = payload.slice(0, MAX_METRICS_CHARS);
      truncated = true;
    }

    const userMessage = `${windowBlock}${audienceBlock}${goalsBlock}

Metrics bundle:
${payload}
${truncated ? '\n[...payload truncated for length — flag as a data gap if relevant]' : ''}

Produce the analytics report. Call publish_analytics_report.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [analyticsTool],
      maxTokens: 3500,
      temperature: 0.3,
      provider: process.env.ANALYTICS_LLM_PROVIDER,
      model: process.env.ANALYTICS_LLM_MODEL,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_analytics_report');
    if (!toolUse) {
      throw new Error('Analytics agent failed to produce structured output: ' + (res.text || '').slice(0, 200));
    }

    const report = toolUse.input;
    ctx.emit('progress', {
      step: 'complete',
      message: `${report.insights?.length || 0} insight${report.insights?.length === 1 ? '' : 's'}, ${report.recommendations?.length || 0} recommendation${report.recommendations?.length === 1 ? '' : 's'}`,
    });

    return { ...report, cost: res.usage };
  },
};
