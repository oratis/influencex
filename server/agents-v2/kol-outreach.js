/**
 * KOL-Outreach Agent — wraps the existing KOL contact + email-generation
 * flow so Conductor can plan around it.
 *
 * Takes a campaign_id + filter criteria, picks top approved KOLs, generates
 * outreach emails using our template system + Claude for personalization,
 * and marks them as drafts ready for human approval.
 *
 * Does NOT send emails. Sending still requires human approval via the
 * Contacts UI (or a later fully-automated mode).
 */

const llm = require('../llm');

function renderPersonalizedEmail({ kol, campaign }) {
  const tone = kol.category ? `active in ${kol.category}` : 'an interesting creator';
  const followersText = kol.followers >= 1_000_000
    ? `${(kol.followers / 1_000_000).toFixed(1)}M`
    : kol.followers >= 1000
      ? `${(kol.followers / 1000).toFixed(0)}K`
      : String(kol.followers || 0);

  const subject = `Partnership opportunity - ${campaign.name}`;
  const body = `Hi ${kol.display_name || kol.username},

I came across your ${kol.platform} channel and found it ${tone}. With ${followersText} followers and strong engagement, your audience looks like a great fit for ${campaign.name}.

I'd love to explore a collaboration. Would you be open to a quick chat about what we're doing?

Best,
${campaign.name} team`;

  return { subject, body };
}

module.exports = {
  id: 'kol-outreach',
  name: 'KOL Outreach',
  description: 'For a campaign, pick top-ranked approved KOLs and generate draft outreach emails. Drafts are stored as contacts; no emails are sent automatically — human review required.',
  version: '1.0.0',
  capabilities: ['kol.outreach.draft'],

  inputSchema: {
    type: 'object',
    required: ['campaign_id'],
    properties: {
      campaign_id: { type: 'string' },
      min_ai_score: { type: 'number', default: 50, description: 'Only target KOLs whose ai_score is at least this' },
      max_drafts: { type: 'number', default: 10, description: 'Stop after this many drafts (budget control)' },
      only_missing: { type: 'boolean', default: true, description: 'Skip KOLs that already have a contact record' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      drafts_created: { type: 'number' },
      kols_considered: { type: 'number' },
      kols_skipped_reason: { type: 'object' },
      drafts: { type: 'array', items: { type: 'object' } },
    },
  },

  costEstimate(input) {
    // If we use personalized Claude, ~¢4 per draft × max_drafts.
    // For v1 we use template-only (no LLM), so cost is effectively zero.
    const max = input?.max_drafts || 10;
    return { usdCents: 0, tokens: 0, kolsMax: max };
  },

  async run(input, ctx) {
    const { db, uuidv4, workspaceId } = ctx;
    if (!db || !uuidv4) throw new Error('kol-outreach requires ctx.db and ctx.uuidv4 (server-wired)');
    if (!input?.campaign_id) throw new Error('campaign_id is required');

    const minScore = input.min_ai_score ?? 50;
    const maxDrafts = Math.min(input.max_drafts ?? 10, 100);
    const onlyMissing = input.only_missing !== false;

    ctx.emit('progress', { step: 'loading', message: `Loading campaign ${input.campaign_id}...` });

    // Campaign must belong to this workspace
    const campaign = await db.queryOne(
      'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?',
      [input.campaign_id, workspaceId]
    );
    if (!campaign) throw new Error('Campaign not found in this workspace');

    ctx.emit('progress', { step: 'filtering', message: `Filtering KOLs (min_ai_score=${minScore})...` });

    // Pick top-ranked approved KOLs with email addresses
    const kolsRes = await db.query(
      `SELECT * FROM kols
       WHERE workspace_id = ? AND campaign_id = ?
         AND status = 'approved'
         AND COALESCE(ai_score, 0) >= ?
         AND email IS NOT NULL AND email != ''
       ORDER BY ai_score DESC, followers DESC
       LIMIT ?`,
      [workspaceId, input.campaign_id, minScore, maxDrafts * 3]
    );
    const kols = kolsRes.rows || [];

    const skipped = { no_email: 0, already_contacted: 0, low_score: 0 };
    const drafts = [];

    for (const kol of kols) {
      if (drafts.length >= maxDrafts) break;

      if (onlyMissing) {
        const exists = await db.queryOne(
          'SELECT id FROM contacts WHERE workspace_id = ? AND kol_id = ?',
          [workspaceId, kol.id]
        );
        if (exists) { skipped.already_contacted++; continue; }
      }

      const { subject, body } = renderPersonalizedEmail({ kol, campaign });
      const id = uuidv4();
      await db.exec(
        'INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, workspaceId, kol.id, input.campaign_id, subject, body, 'affiliate', 'draft']
      );
      drafts.push({
        contact_id: id,
        kol_id: kol.id,
        kol_name: kol.display_name || kol.username,
        platform: kol.platform,
        followers: kol.followers,
        ai_score: kol.ai_score,
        email_to: kol.email,
      });

      ctx.emit('progress', { step: `drafted.${drafts.length}`, message: `Drafted: ${kol.display_name || kol.username}` });
    }

    ctx.emit('progress', { step: 'complete', message: `${drafts.length} outreach drafts created (review in Contacts)` });

    return {
      drafts_created: drafts.length,
      kols_considered: kols.length,
      kols_skipped_reason: skipped,
      campaign_name: campaign.name,
      drafts,
      cost: { inputTokens: 0, outputTokens: 0, usdCents: 0 },
    };
  },
};
