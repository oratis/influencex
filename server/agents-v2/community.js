/**
 * Community Agent — pulls mentions / comments / DMs into `inbox_messages`
 * and drafts replies that stay on-brand.
 *
 * Phase G MVP scope:
 *   - `fetch` action: pull recent X (Twitter) mentions for the configured
 *     account, dedupe by (workspace_id, platform, external_id), write into
 *     inbox_messages. LinkedIn/IG/TikTok are scaffolded with a "not
 *     implemented yet" branch — structure is ready, wiring lands in
 *     follow-up commits.
 *   - `classify` action: run a cheap LLM pass to tag sentiment + priority
 *     on every open message without one.
 *   - `draft` action: for a specific inbox row, produce an on-brand reply
 *     (stored in `inbox_messages.draft_reply`) — the operator reviews and
 *     sends. No auto-send in v1.
 *
 * Why three actions not one: fetch + classify are cron-worthy background
 * jobs; draft is on-demand. Keeping them separate lets the scheduler
 * tick fetch/classify while the UI fires draft synchronously from a
 * specific row click.
 */

const llm = require('../llm');
const fetch = require('../proxy-fetch');

const REPLY_SYSTEM_PROMPT = `You are a community manager writing on behalf of a brand. Draft a reply to the user's message.

Rules:
- Match the brand voice supplied in the system context. If no voice is supplied, be concise, warm, and professional.
- Stay under the platform's character limit (X: 280, LinkedIn: 600).
- Acknowledge the user's concern or question specifically — do NOT paste generic "Thanks for reaching out!" boilerplate.
- If the message is hostile or off-topic, return a polite short acknowledgement or a suggestion to take the conversation to DM/support — never escalate.
- If the message is spam or a bot, return an empty reply (empty string).
- Never promise discounts, refunds, or product capabilities unless the brand voice explicitly allows it.`;

const CLASSIFY_SYSTEM_PROMPT = `You are a triage analyst. For each message, emit sentiment ∈ {positive, neutral, negative, hostile, spam} and priority ∈ {urgent, normal, low}.

- urgent = user is blocked / complaint / PR risk
- normal = real question or meaningful engagement
- low = thanks / emojis / bot

Call publish_triage.`;

const classifyTool = {
  name: 'publish_triage',
  description: 'Emit the triage decision.',
  input_schema: {
    type: 'object',
    required: ['sentiment', 'priority'],
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'hostile', 'spam'] },
      priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
};

// --- Platform fetchers --------------------------------------------------

/**
 * Pull recent mentions from X. Returns raw rows in a platform-neutral
 * shape the caller will write into inbox_messages.
 *
 * We use the v2 "recent search" endpoint with query `@<handle>` because
 * the user-mentions timeline endpoint requires the user id upfront and
 * rate-limits more aggressively.
 */
async function fetchXMentions({ accessToken, handle, sinceId }) {
  const query = encodeURIComponent(`@${handle} -is:retweet`);
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=30&tweet.fields=created_at,author_id,conversation_id,in_reply_to_user_id&expansions=author_id&user.fields=username,name,profile_image_url${sinceId ? `&since_id=${sinceId}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`X mentions ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const users = {};
  for (const u of data.includes?.users || []) users[u.id] = u;
  return (data.data || []).map(t => {
    const u = users[t.author_id] || {};
    return {
      platform: 'twitter',
      kind: 'mention',
      external_id: t.id,
      thread_id: t.conversation_id,
      parent_id: t.in_reply_to_user_id,
      author_handle: u.username ? `@${u.username}` : null,
      author_name: u.name || null,
      author_avatar_url: u.profile_image_url || null,
      text: t.text,
      url: u.username ? `https://twitter.com/${u.username}/status/${t.id}` : null,
      occurred_at: t.created_at,
      raw: t,
    };
  });
}

// --- Agent --------------------------------------------------------------

module.exports = {
  id: 'community',
  name: 'Community Manager',
  description: 'Pulls mentions/comments/DMs into the inbox, classifies sentiment + priority, and drafts on-brand replies. Currently wired for X; LinkedIn / IG / TikTok scaffolded.',
  version: '0.1.0',
  capabilities: ['community.fetch', 'community.classify', 'community.draft_reply'],

  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['fetch', 'classify', 'draft'] },
      // For 'fetch': restrict to a subset of connected platforms.
      platforms: { type: 'array', items: { type: 'string' } },
      // For 'draft': which inbox row to reply to.
      inbox_message_id: { type: 'string' },
      // Brand voice override for the draft.
      brand_voice: { type: 'string' },
      // For 'classify': limit how many messages per tick.
      limit: { type: 'number', default: 20 },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      fetched: { type: 'number' },
      classified: { type: 'number' },
      draft_reply: { type: 'string' },
    },
  },

  costEstimate() {
    // fetch = 0 LLM; classify + draft are both Haiku-class tasks.
    return { tokens: 1500, usdCents: 1 };
  },

  async run(input, ctx) {
    const action = input?.action;
    if (!action) throw new Error('action is required (fetch | classify | draft)');

    if (action === 'fetch') return this._fetchAction(input, ctx);
    if (action === 'classify') return this._classifyAction(input, ctx);
    if (action === 'draft') return this._draftAction(input, ctx);
    throw new Error(`Unknown action: ${action}`);
  },

  async _fetchAction(input, ctx) {
    const db = ctx.db;
    if (!db) throw new Error('Community fetch requires a db ctx');
    const platforms = input.platforms?.length ? input.platforms : ['twitter'];
    let fetched = 0;

    for (const platform of platforms) {
      ctx.emit('progress', { step: 'fetch', message: `Pulling ${platform} mentions...` });
      const conn = await db.queryOne(
        'SELECT * FROM platform_connections WHERE workspace_id = ? AND platform = ?',
        [ctx.workspaceId, platform]
      );
      if (!conn) {
        ctx.emit('progress', { step: 'skip', message: `${platform} not connected — skipping` });
        continue;
      }
      if (platform !== 'twitter') {
        ctx.emit('progress', { step: 'skip', message: `${platform} fetcher not implemented yet — skipping` });
        continue;
      }
      try {
        const rows = await fetchXMentions({
          accessToken: conn.access_token,
          handle: (conn.account_name || '').replace(/^@/, ''),
          sinceId: null,
        });
        for (const r of rows) {
          try {
            await db.exec(
              `INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id, thread_id, parent_id, author_handle, author_name, author_avatar_url, text, url, occurred_at, raw)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [ctx.uuidv4(), ctx.workspaceId, r.platform, r.kind, r.external_id, r.thread_id, r.parent_id,
               r.author_handle, r.author_name, r.author_avatar_url, r.text, r.url, r.occurred_at, JSON.stringify(r.raw)]
            );
            fetched++;
          } catch (e) {
            // Unique-index violation is fine — means we already have this message.
            if (!/UNIQUE|duplicate/i.test(e.message)) throw e;
          }
        }
      } catch (e) {
        ctx.emit('progress', { step: 'error', message: `${platform} fetch failed: ${e.message}` });
      }
    }
    ctx.emit('progress', { step: 'complete', message: `Fetched ${fetched} new message(s)` });
    return { action: 'fetch', fetched };
  },

  async _classifyAction(input, ctx) {
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');
    const db = ctx.db;
    if (!db) throw new Error('Community classify requires a db ctx');
    const limit = input.limit || 20;
    const { rows } = await db.query(
      "SELECT id, text FROM inbox_messages WHERE workspace_id = ? AND sentiment IS NULL AND status = 'open' LIMIT ?",
      [ctx.workspaceId, limit]
    );
    let classified = 0;
    for (const row of rows || []) {
      try {
        const res = await llm.complete({
          messages: [{ role: 'user', content: `Message:\n${row.text}\n\nCall publish_triage.` }],
          system: CLASSIFY_SYSTEM_PROMPT,
          tools: [classifyTool],
          maxTokens: 200,
          temperature: 0,
        });
        const tu = (res.toolUses || []).find(t => t.name === 'publish_triage');
        if (!tu) continue;
        await db.exec(
          'UPDATE inbox_messages SET sentiment = ?, priority = ?, tags = ? WHERE id = ?',
          [tu.input.sentiment, tu.input.priority, JSON.stringify(tu.input.tags || []), row.id]
        );
        classified++;
      } catch (e) {
        ctx.emit('progress', { step: 'classify-error', message: `${row.id}: ${e.message}` });
      }
    }
    ctx.emit('progress', { step: 'complete', message: `Classified ${classified}/${rows?.length || 0}` });
    return { action: 'classify', classified };
  },

  async _draftAction(input, ctx) {
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');
    if (!input.inbox_message_id) throw new Error('inbox_message_id is required for draft action');
    const db = ctx.db;
    if (!db) throw new Error('Community draft requires a db ctx');
    const row = await db.queryOne(
      'SELECT * FROM inbox_messages WHERE id = ? AND workspace_id = ?',
      [input.inbox_message_id, ctx.workspaceId]
    );
    if (!row) throw new Error('inbox_message not found');

    const voiceLine = input.brand_voice ? `\n\nBrand voice:\n${input.brand_voice}` : '';
    const charLimit = row.platform === 'twitter' ? 280 : 600;
    const userMessage = `Platform: ${row.platform} (reply in ≤${charLimit} chars)
From: ${row.author_handle || row.author_name || 'unknown'}
Message: ${row.text}${voiceLine}

Draft a reply. Return just the reply text, no quotes or labels.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: REPLY_SYSTEM_PROMPT,
      maxTokens: 400,
      temperature: 0.6,
    });
    const draft = (res.text || '').trim();
    await db.exec(
      'UPDATE inbox_messages SET draft_reply = ? WHERE id = ?',
      [draft, row.id]
    );
    ctx.emit('progress', { step: 'complete', message: `Drafted ${draft.length}-char reply` });
    return { action: 'draft', draft_reply: draft, cost: res.usage };
  },
};
