/**
 * Discovery Agent (v2, new Agent interface)
 *
 * Wraps the existing discovery-agent.js search helper with the standard
 * Agent contract: streaming events, cost estimation, typed inputs/outputs.
 */

const legacyDiscovery = require('../agents/discovery-agent');
const quota = require('../youtube-quota');

module.exports = {
  id: 'discovery',
  name: 'Creator Discovery',
  description: 'Find YouTube creators by keyword, subscriber range, and relevance. Returns channels ranked by relevance score.',
  version: '1.0.0',
  capabilities: ['discover.youtube'],

  inputSchema: {
    type: 'object',
    required: ['keywords'],
    properties: {
      keywords: { type: 'string', description: 'Comma-separated search keywords' },
      min_subscribers: { type: 'number', default: 1000 },
      max_results: { type: 'number', default: 50, maximum: 200 },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channelId: { type: 'string' },
            channel_name: { type: 'string' },
            subscribers: { type: 'number' },
            relevance_score: { type: 'number' },
            category: { type: 'string' },
            channel_url: { type: 'string' },
          },
        },
      },
      total: { type: 'number' },
      source: { type: 'string' },
    },
  },

  costEstimate(input) {
    // Each keyword costs 101 units (1 search + 1 channels batch).
    const kwCount = (input.keywords || '').split(',').filter(k => k.trim()).length || 1;
    const unitsPerKeyword = 101;
    return {
      tokens: 0,
      usdCents: 0,
      quotaUnits: kwCount * unitsPerKeyword,
    };
  },

  async run(input, ctx) {
    ctx.emit('progress', { step: 'validate', message: `Checking YouTube API config + quota...` });

    const q = quota.status();
    if (q.remaining < 100) {
      throw new Error(`YouTube API quota near exhausted (${q.used}/${q.dailyLimit}). Try again after midnight PT.`);
    }

    ctx.emit('progress', {
      step: 'searching',
      message: `Searching YouTube for "${input.keywords}" (min ${input.min_subscribers || 1000} subs)...`,
    });

    const result = await legacyDiscovery.searchYouTubeChannels({
      keywords: input.keywords,
      maxResults: Math.min(input.max_results || 50, 200),
      minSubscribers: input.min_subscribers || 1000,
    });

    if (!result.success) {
      throw new Error(result.error || 'Discovery failed');
    }

    ctx.emit('progress', {
      step: 'results',
      message: `Found ${result.channels.length} matching channels`,
    });

    return {
      channels: result.channels,
      total: result.channels.length,
      source: 'youtube-data-api',
    };
  },
};
