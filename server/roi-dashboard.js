/**
 * ROI dashboard aggregator.
 *
 * Given a campaign, return a single JSON blob with everything the frontend
 * needs to show a campaign ROI summary: KOL counts by stage, content
 * performance, cost/CPM estimates, and a conversion funnel.
 */

async function getCampaignRoi(campaignId, deps) {
  const { query, queryOne } = deps;

  // Daily event timeline over the last 30 days — sent/delivered/opened/replied
  // grouped by day for charting. We pull from email_events for delivered+opened
  // (webhook-driven) and from contacts.sent_at/reply_at for sent+replied
  // (always present). This way SMTP installs without webhooks still get a
  // usable timeline (minus open tracking).
  const timelineRes = await query(
    `WITH d AS (
       SELECT date(sent_at) as day, 'sent' as kind
       FROM contacts WHERE campaign_id = ? AND sent_at IS NOT NULL
         AND sent_at >= datetime('now','-30 days')
       UNION ALL
       SELECT date(reply_at) as day, 'replied' as kind
       FROM contacts WHERE campaign_id = ? AND reply_at IS NOT NULL
         AND reply_at >= datetime('now','-30 days')
       UNION ALL
       SELECT date(e.occurred_at) as day, e.event_type as kind
       FROM email_events e JOIN contacts c ON c.id = e.contact_id
       WHERE c.campaign_id = ?
         AND e.occurred_at >= datetime('now','-30 days')
         AND e.event_type IN ('delivered','opened','bounced','failed')
     )
     SELECT day, kind, COUNT(*) as n FROM d GROUP BY day, kind ORDER BY day ASC`,
    [campaignId, campaignId, campaignId]
  );
  const timelineMap = {};
  for (const r of (timelineRes.rows || [])) {
    const day = r.day;
    if (!timelineMap[day]) timelineMap[day] = { day, sent: 0, delivered: 0, opened: 0, replied: 0, failed: 0 };
    const k = r.kind === 'bounced' ? 'failed' : r.kind;
    timelineMap[day][k] = (timelineMap[day][k] || 0) + parseInt(r.n);
  }
  const timeline = Object.values(timelineMap).sort((a, b) => a.day.localeCompare(b.day));

  const campaign = await queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  if (!campaign) {
    return { error: 'Campaign not found' };
  }

  // KOL counts by status
  const kolStatsRes = await query(
    `SELECT status, COUNT(*) as count, AVG(ai_score) as avg_score,
            SUM(followers) as total_followers, AVG(engagement_rate) as avg_engagement,
            SUM(avg_views) as total_avg_views, AVG(estimated_cpm) as avg_cpm
     FROM kols WHERE campaign_id = ? GROUP BY status`,
    [campaignId]
  );
  const kolByStatus = {};
  for (const r of kolStatsRes.rows || []) {
    kolByStatus[r.status] = {
      count: parseInt(r.count),
      avgScore: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      totalFollowers: parseInt(r.total_followers) || 0,
      avgEngagement: r.avg_engagement ? Number(r.avg_engagement).toFixed(2) : null,
      totalAvgViews: parseInt(r.total_avg_views) || 0,
      avgCpm: r.avg_cpm ? Number(r.avg_cpm).toFixed(2) : null,
    };
  }

  // Contact funnel. Each stage "contains" the next: a replied contact
  // also counts toward opened, delivered, and sent. This lets the UI draw a
  // monotonic-decreasing funnel instead of a bar chart with awkward gaps.
  const contactFunnel = await query(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as drafts,
       SUM(CASE WHEN scheduled_send_at IS NOT NULL AND sent_at IS NULL THEN 1 ELSE 0 END) as scheduled,
       SUM(CASE WHEN status IN ('sent','delivered','opened','replied','bounced','failed') THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN status IN ('delivered','opened','replied') THEN 1 ELSE 0 END) as delivered,
       SUM(CASE WHEN status IN ('opened','replied') THEN 1 ELSE 0 END) as opened,
       SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) as replied,
       SUM(CASE WHEN status IN ('bounced','failed') THEN 1 ELSE 0 END) as bounced_or_failed,
       SUM(CASE WHEN contract_status='signed' THEN 1 ELSE 0 END) as signed,
       SUM(CASE WHEN content_status='published' OR content_status='approved' THEN 1 ELSE 0 END) as content_done,
       SUM(CASE WHEN payment_status='paid' THEN 1 ELSE 0 END) as paid,
       COALESCE(SUM(payment_amount), 0) as total_spent
     FROM contacts WHERE campaign_id = ?`,
    [campaignId]
  );
  const funnel = contactFunnel.rows?.[0] || {};
  const asNum = v => parseInt(v) || 0;

  // Content performance (views/likes/etc from published content)
  const contentPerfRes = await query(
    `SELECT
       COUNT(*) as count,
       COALESCE(SUM(views), 0) as total_views,
       COALESCE(SUM(likes), 0) as total_likes,
       COALESCE(SUM(comments), 0) as total_comments,
       COALESCE(SUM(shares), 0) as total_shares
     FROM content_data WHERE content_url IN (
       SELECT content_url FROM contacts WHERE campaign_id = ? AND content_url IS NOT NULL
     )`,
    [campaignId]
  );
  const contentPerf = contentPerfRes.rows?.[0] || {};

  // Compute conversion rates
  const totalContacts = asNum(funnel.total);
  const sent = asNum(funnel.sent);
  const delivered = asNum(funnel.delivered);
  const opened = asNum(funnel.opened);
  const replied = asNum(funnel.replied);
  const bouncedOrFailed = asNum(funnel.bounced_or_failed);
  const signed = asNum(funnel.signed);
  const contentDone = asNum(funnel.content_done);
  const paid = asNum(funnel.paid);

  const rate = (num, denom) => (denom > 0 ? (num / denom * 100).toFixed(1) : '0.0');

  // Calculate ROI indicators
  const totalSpent = Number(funnel.total_spent) || 0;
  const budget = Number(campaign.budget) || 0;
  const totalViews = asNum(contentPerf.total_views);
  const totalEngagement = asNum(contentPerf.total_likes) + asNum(contentPerf.total_comments) + asNum(contentPerf.total_shares);
  // CPM = cost per 1000 views
  const effectiveCpm = totalViews > 0 && totalSpent > 0
    ? (totalSpent / totalViews * 1000).toFixed(2)
    : null;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      budget,
      budget_spent: totalSpent,
      budget_remaining: Math.max(0, budget - totalSpent),
      budget_utilization: budget > 0 ? (totalSpent / budget * 100).toFixed(1) : null,
    },
    kols: {
      byStatus: kolByStatus,
      total: Object.values(kolByStatus).reduce((s, x) => s + x.count, 0),
    },
    funnel: {
      total_contacts: totalContacts,
      drafts: asNum(funnel.drafts),
      scheduled: asNum(funnel.scheduled),
      sent_or_beyond: sent,
      delivered: delivered,
      opened: opened,
      replied: replied,
      bounced_or_failed: bouncedOrFailed,
      signed_contracts: signed,
      content_done: contentDone,
      paid: paid,
      rates: {
        delivery_rate: rate(delivered, sent),
        open_rate: rate(opened, delivered),
        reply_rate: rate(replied, sent),
        bounce_rate: rate(bouncedOrFailed, sent),
        contract_rate: rate(signed, replied),
        completion_rate: rate(contentDone, signed),
        payment_rate: rate(paid, contentDone),
      },
    },
    content_performance: {
      content_count: asNum(contentPerf.count),
      total_views: totalViews,
      total_likes: asNum(contentPerf.total_likes),
      total_comments: asNum(contentPerf.total_comments),
      total_shares: asNum(contentPerf.total_shares),
      total_engagement: totalEngagement,
      engagement_rate: totalViews > 0 ? (totalEngagement / totalViews * 100).toFixed(2) : '0.00',
    },
    roi: {
      total_spent: totalSpent,
      cost_per_signed_contract: signed > 0 ? (totalSpent / signed).toFixed(2) : null,
      cost_per_completed: contentDone > 0 ? (totalSpent / contentDone).toFixed(2) : null,
      effective_cpm: effectiveCpm,
    },
    email_timeline: timeline,
  };
}

module.exports = { getCampaignRoi };
