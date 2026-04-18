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
const crypto = require('crypto');
const { safeFetch } = require('../web/web-fetch');

function simpleDiff(oldText, newText) {
  // Token-ish diff: compare by lines, produce a concise summary of added/removed lines.
  if (!oldText) return { added: [], removed: [], unchanged: true };
  const oldLines = new Set(oldText.split('\n').map(l => l.trim()).filter(l => l.length > 8));
  const newLines = newText.split('\n').map(l => l.trim()).filter(l => l.length > 8);
  const added = newLines.filter(l => !oldLines.has(l)).slice(0, 20);
  const removed = [...oldLines].filter(l => !newLines.includes(l)).slice(0, 20);
  return { added, removed, unchanged: added.length === 0 && removed.length === 0 };
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

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
        description: 'List of competitor names or HTTPS URLs. When an HTTPS URL is given, we fetch the page + diff against any prior snapshot in this workspace.',
        minItems: 1,
      },
      our_positioning: { type: 'string', description: 'Short description of our own product for context' },
      category: { type: 'string', description: 'e.g. "AI content marketing", "project management"' },
      skip_fetch: { type: 'boolean', default: false, description: 'Skip live fetch; use model knowledge only' },
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

    // Live-fetch HTTPS URLs + diff against prior snapshots (when ctx.db available)
    const liveFetches = [];
    const changes = [];
    if (!input.skip_fetch && ctx.db && ctx.uuidv4) {
      for (const entry of input.competitors) {
        if (!/^https:\/\//i.test(entry)) continue;
        try {
          ctx.emit('progress', { step: 'fetching', message: `GET ${entry}` });
          const r = await safeFetch(entry, { maxBytes: 3 * 1024 * 1024, timeoutMs: 20000, extractLinks: false });
          const digest = (r.text || '').slice(0, 6000);
          const hash = hashText(digest);

          // Find prior snapshot
          const prev = await ctx.db.queryOne(
            'SELECT text_digest, content_hash, captured_at FROM competitor_snapshots WHERE workspace_id = ? AND url = ? ORDER BY captured_at DESC LIMIT 1',
            [ctx.workspaceId, entry]
          );

          const diff = prev ? simpleDiff(prev.text_digest, digest) : { added: [], removed: [], unchanged: false };

          liveFetches.push({
            url: entry,
            title: r.title,
            text_length: (r.text || '').length,
            changed: !!prev && !diff.unchanged,
            first_seen: !prev,
            previous_captured_at: prev?.captured_at,
          });

          if (prev && (diff.added.length || diff.removed.length)) {
            changes.push({ url: entry, added: diff.added, removed: diff.removed });
          }

          // Store new snapshot (always — lets us trend over time)
          await ctx.db.exec(
            'INSERT INTO competitor_snapshots (id, workspace_id, competitor_name, url, title, text_digest, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [ctx.uuidv4(), ctx.workspaceId, entry, entry, r.title || '', digest, hash]
          );
        } catch (e) {
          ctx.emit('progress', { step: 'fetch-fail', message: `${entry}: ${e.message}` });
        }
      }
    }

    const fetchBlock = liveFetches.length
      ? '\n\nLive-fetched pages (use these as ground truth for current positioning):\n' +
        liveFetches.map(f => `  - ${f.url}: ${f.title || '(no title)'} [${f.first_seen ? 'first seen' : f.changed ? 'changed since last capture' : 'unchanged'}]`).join('\n')
      : '';
    const diffBlock = changes.length
      ? '\n\nDetected changes since last snapshot:\n' + changes.map(c =>
          `  ${c.url}:\n    + ${c.added.slice(0, 3).join(' | ')}\n    - ${c.removed.slice(0, 3).join(' | ')}`
        ).join('\n')
      : '';

    const userMessage = `Competitors: ${input.competitors.join(', ')}
${input.our_positioning ? `Our positioning: ${input.our_positioning}` : ''}
${input.category ? `Category: ${input.category}` : ''}${fetchBlock}${diffBlock}

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
