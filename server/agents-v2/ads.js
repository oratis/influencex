/**
 * Ads Agent — produces a structured paid-media plan for a given brand +
 * campaign brief. Phase D MVP scope: offline planning only, no live API
 * calls to Meta Ads or Google Ads yet.
 *
 * Output covers three platforms out of the box (Meta, Google, TikTok Ads)
 * and is structured so downstream integrations can consume it verbatim
 * when live connectors land:
 *
 *   - Creative variants (3-6 per platform) with copy + visual brief
 *   - Audience targeting (demographics, interests, behaviors, lookalikes)
 *   - Budget split + pacing window + bidding strategy
 *   - KPI targets (CPA / ROAS / CTR) with rationale
 *   - UTM plan so clicks can be attributed in the existing analytics tables
 *
 * Why offline-first: before we wire Meta Marketing API + Google Ads API the
 * agent can still unblock the user by producing a campaign plan they can
 * paste into Ads Manager. Live execution becomes a second tool call on the
 * same output shape (the fields map 1:1 to Meta/Google campaign creation).
 */

const llm = require('../llm');

const SYSTEM_PROMPT = `You are a senior paid-media strategist with deep expertise in Meta Ads, Google Ads, and TikTok Ads.

Rules:
- Produce CONCRETE plans — actual headline text, actual audience targeting criteria, actual budget numbers (not "allocate budget appropriately").
- Ground creative choices in the campaign objective (awareness vs conversion vs retargeting need different hooks).
- For audience targeting: list interests/behaviors that exist on the platform (e.g. "Interest: Content marketing" on Meta), not generic descriptions.
- Budget split should reflect platform strengths: Meta for broad prospecting, Google Search for high-intent bottom-funnel, TikTok for awareness with younger demos.
- KPI targets must be realistic for the industry + funnel stage. Cite the assumption.
- UTM params: utm_source = platform, utm_medium = 'cpc' or 'paid_social', utm_campaign = short campaign slug.
- Never invent currency-specific data (CPM rates in INR vs USD) without the user telling you the market.

Call publish_ads_plan.`;

const adsTool = {
  name: 'publish_ads_plan',
  description: 'Emit the structured ads plan.',
  input_schema: {
    type: 'object',
    required: ['campaign_slug', 'objective', 'platforms', 'budget', 'kpis'],
    properties: {
      campaign_slug: { type: 'string', description: 'URL-safe slug, e.g. spring-launch-2026' },
      objective: { type: 'string', enum: ['awareness', 'consideration', 'conversion', 'retargeting'] },
      duration_days: { type: 'number' },
      budget: {
        type: 'object',
        required: ['total_usd', 'split'],
        properties: {
          total_usd: { type: 'number' },
          split: {
            type: 'array',
            items: {
              type: 'object',
              required: ['platform', 'pct'],
              properties: {
                platform: { type: 'string', enum: ['meta', 'google_search', 'google_display', 'tiktok', 'youtube'] },
                pct: { type: 'number' },
                rationale: { type: 'string' },
              },
            },
          },
          pacing: { type: 'string', description: 'e.g. "standard", "accelerated for first 3 days then standard"' },
        },
      },
      platforms: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'creatives', 'audience'],
          properties: {
            platform: { type: 'string' },
            bidding: { type: 'string', description: 'e.g. "Lowest cost with $15 CPA bid cap", "Target ROAS 3.0"' },
            creatives: {
              type: 'array',
              items: {
                type: 'object',
                required: ['hook', 'headline'],
                properties: {
                  hook: { type: 'string', description: 'First-line attention grab (10-15 words)' },
                  headline: { type: 'string' },
                  body: { type: 'string' },
                  cta: { type: 'string', description: 'Platform-standard CTA label (e.g. "Shop Now", "Learn More")' },
                  visual_brief: { type: 'string', description: 'Concrete image/video direction' },
                  format: { type: 'string', description: 'e.g. "1:1 image", "9:16 video 15s", "carousel 5-card"' },
                },
              },
            },
            audience: {
              type: 'object',
              properties: {
                demographics: { type: 'string' },
                interests: { type: 'array', items: { type: 'string' } },
                behaviors: { type: 'array', items: { type: 'string' } },
                lookalike_seed: { type: 'string', description: 'e.g. "website visitors last 30d", "purchasers last 180d"' },
                exclusions: { type: 'array', items: { type: 'string' } },
              },
            },
            utm: {
              type: 'object',
              properties: {
                utm_source: { type: 'string' },
                utm_medium: { type: 'string' },
                utm_campaign: { type: 'string' },
              },
            },
          },
        },
      },
      kpis: {
        type: 'object',
        properties: {
          primary: { type: 'string', description: 'e.g. "CPA ≤ $25"' },
          secondary: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
      risks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Known constraints: ad-platform policy risks, creative fatigue, etc.',
      },
    },
  },
};

module.exports = {
  id: 'ads',
  name: 'Ads Strategist',
  description: 'Produce a structured paid-media plan (creatives, audiences, budget split, UTMs) for Meta / Google / TikTok. Offline planner — no live API calls yet.',
  version: '0.1.0',
  capabilities: ['ads.plan'],

  inputSchema: {
    type: 'object',
    required: ['brand', 'objective', 'total_budget_usd'],
    properties: {
      brand: { type: 'string', description: 'Product or brand name' },
      product_url: { type: 'string' },
      objective: { type: 'string', enum: ['awareness', 'consideration', 'conversion', 'retargeting'] },
      audience_notes: { type: 'string', description: 'Free-form description of target audience' },
      total_budget_usd: { type: 'number' },
      duration_days: { type: 'number', description: 'Campaign length in days', default: 14 },
      geo: { type: 'string', description: 'Market, e.g. "US", "DE", "en-GB"' },
      platforms: {
        type: 'array',
        description: 'Restrict to a subset (default: meta + google_search + tiktok)',
        items: { type: 'string' },
      },
    },
  },

  outputSchema: adsTool.input_schema,

  costEstimate() {
    // Bigger output than SEO brief — 3 platforms x ~5 creatives each.
    return { tokens: 4000, usdCents: 10 };
  },

  async run(input, ctx) {
    if (!input?.brand) throw new Error('brand is required');
    if (!input?.objective) throw new Error('objective is required');
    if (!input?.total_budget_usd) throw new Error('total_budget_usd is required');
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    const platforms = input.platforms?.length ? input.platforms : ['meta', 'google_search', 'tiktok'];
    const duration = input.duration_days || 14;

    ctx.emit('progress', { step: 'planning', message: `Drafting ${platforms.length}-platform ads plan for "${input.brand}"...` });

    const userMessage = `Brand: ${input.brand}
${input.product_url ? `URL: ${input.product_url}` : ''}
Objective: ${input.objective}
Total budget: $${input.total_budget_usd} USD over ${duration} days
Geo/market: ${input.geo || 'not specified'}
Platforms to plan for: ${platforms.join(', ')}
${input.audience_notes ? `Audience notes: ${input.audience_notes}` : ''}

Produce a complete ads plan. Allocate budget across the requested platforms with rationale. Include 3-5 creative variants per platform, concrete audience targeting per platform, and a realistic KPI target. Call publish_ads_plan.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      tools: [adsTool],
      maxTokens: 4000,
      temperature: 0.5,
      provider: process.env.ADS_LLM_PROVIDER,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'publish_ads_plan');
    if (!toolUse) throw new Error('Ads agent failed to produce structured output: ' + res.text.slice(0, 200));

    const plan = toolUse.input;
    const totalCreatives = (plan.platforms || []).reduce((n, p) => n + (p.creatives?.length || 0), 0);
    ctx.emit('progress', {
      step: 'complete',
      message: `${plan.platforms?.length || 0} platforms, ${totalCreatives} creatives, $${plan.budget?.total_usd || input.total_budget_usd} total`,
    });

    return {
      ...plan,
      // Execution hints — mark every platform as plan-only until live connectors exist.
      execution: {
        mode: 'offline_plan',
        note: 'No ads were created. Copy-paste into Meta/Google/TikTok Ads Manager, or wait for live API integration.',
      },
      cost: res.usage,
    };
  },
};
