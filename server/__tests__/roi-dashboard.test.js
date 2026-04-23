/**
 * Tests for the ROI dashboard aggregator.
 *
 * Covers:
 *   - Missing campaign → error response shape
 *   - Empty campaign → zero funnel, empty timeline, null rates that don't crash
 *   - Funnel math with nested stages (replied ⊆ opened ⊆ delivered ⊆ sent)
 *   - Timeline aggregation groups raw rows by day + kind
 *   - Bounce/failure reporting via bounced_or_failed counter
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCampaignRoi } = require('../roi-dashboard');

function mockDeps({ campaign, kolStats = [], funnel = {}, contentPerf = {}, timelineRows = [] }) {
  const queryOne = async (sql, params) => {
    if (/FROM campaigns/.test(sql)) return campaign;
    return null;
  };
  const query = async (sql) => {
    // Check timeline FIRST: its SQL also contains "FROM contacts WHERE
    // campaign_id" inside the CTE, so we must not fall through to the
    // funnel branch.
    if (/WITH d AS/.test(sql) || /email_events/.test(sql)) return { rows: timelineRows };
    if (/FROM kols WHERE campaign_id/.test(sql)) return { rows: kolStats };
    if (/FROM content_data/.test(sql)) return { rows: [contentPerf] };
    if (/FROM contacts WHERE campaign_id/.test(sql)) return { rows: [funnel] };
    return { rows: [] };
  };
  return { query, queryOne };
}

test('missing campaign returns error object', async () => {
  const r = await getCampaignRoi('nope', mockDeps({ campaign: null }));
  assert.equal(r.error, 'Campaign not found');
});

test('empty campaign yields zero counts and sane defaults', async () => {
  const r = await getCampaignRoi('c1', mockDeps({
    campaign: { id: 'c1', name: 'Empty', status: 'active', budget: 0 },
  }));
  assert.equal(r.funnel.total_contacts, 0);
  assert.equal(r.funnel.sent_or_beyond, 0);
  assert.equal(r.funnel.delivered, 0);
  assert.equal(r.funnel.opened, 0);
  assert.equal(r.funnel.replied, 0);
  assert.equal(r.funnel.rates.reply_rate, '0.0');
  assert.equal(r.funnel.rates.delivery_rate, '0.0');
  assert.equal(r.funnel.rates.open_rate, '0.0');
  assert.deepEqual(r.email_timeline, []);
});

test('funnel rates: nested-containment math is correct', async () => {
  // 100 sent, 80 delivered (80%), 40 opened (50% of delivered), 10 replied
  const r = await getCampaignRoi('c2', mockDeps({
    campaign: { id: 'c2', name: 'N', status: 'active', budget: 1000 },
    funnel: {
      total: 100, drafts: 0, scheduled: 0, sent: 100, delivered: 80, opened: 40,
      replied: 10, bounced_or_failed: 5, signed: 3, content_done: 2, paid: 1,
      total_spent: 200,
    },
  }));
  assert.equal(r.funnel.sent_or_beyond, 100);
  assert.equal(r.funnel.delivered, 80);
  assert.equal(r.funnel.opened, 40);
  assert.equal(r.funnel.replied, 10);
  assert.equal(r.funnel.rates.delivery_rate, '80.0');
  assert.equal(r.funnel.rates.open_rate, '50.0');           // opened / delivered
  assert.equal(r.funnel.rates.reply_rate, '10.0');          // replied / sent
  assert.equal(r.funnel.rates.bounce_rate, '5.0');
  assert.equal(r.funnel.rates.contract_rate, '30.0');       // signed / replied
  assert.equal(r.funnel.rates.completion_rate, '66.7');     // content_done / signed
  assert.equal(r.funnel.rates.payment_rate, '50.0');        // paid / content_done
});

test('timeline aggregates raw daily rows by kind', async () => {
  const r = await getCampaignRoi('c3', mockDeps({
    campaign: { id: 'c3', name: 'N', status: 'active', budget: 0 },
    timelineRows: [
      { day: '2026-04-20', kind: 'sent', n: 5 },
      { day: '2026-04-20', kind: 'delivered', n: 4 },
      { day: '2026-04-20', kind: 'opened', n: 2 },
      { day: '2026-04-21', kind: 'sent', n: 3 },
      { day: '2026-04-21', kind: 'bounced', n: 1 },
    ],
  }));
  const day20 = r.email_timeline.find(d => d.day === '2026-04-20');
  const day21 = r.email_timeline.find(d => d.day === '2026-04-21');
  assert.ok(day20);
  assert.ok(day21);
  assert.equal(day20.sent, 5);
  assert.equal(day20.delivered, 4);
  assert.equal(day20.opened, 2);
  assert.equal(day20.replied, 0);       // absent defaults to 0
  assert.equal(day21.sent, 3);
  assert.equal(day21.failed, 1);         // bounced collapses into failed bucket
});

test('effective_cpm is null when either views or spend is zero', async () => {
  const r = await getCampaignRoi('c4', mockDeps({
    campaign: { id: 'c4', name: 'N', status: 'active', budget: 500 },
    funnel: { total: 10, sent: 10, delivered: 0, opened: 0, replied: 0, bounced_or_failed: 0, signed: 0, content_done: 0, paid: 0, total_spent: 0 },
    contentPerf: { count: 0, total_views: 0, total_likes: 0, total_comments: 0, total_shares: 0 },
  }));
  assert.equal(r.roi.effective_cpm, null);
});

test('budget utilization is computed only when budget > 0', async () => {
  const withBudget = await getCampaignRoi('c5', mockDeps({
    campaign: { id: 'c5', name: 'B', status: 'active', budget: 1000 },
    funnel: { total: 1, sent: 1, delivered: 1, opened: 1, replied: 1, bounced_or_failed: 0, signed: 1, content_done: 1, paid: 1, total_spent: 250 },
  }));
  assert.equal(withBudget.campaign.budget_utilization, '25.0');

  const noBudget = await getCampaignRoi('c5', mockDeps({
    campaign: { id: 'c5', name: 'B', status: 'active', budget: 0 },
    funnel: { total: 0, sent: 0, delivered: 0, opened: 0, replied: 0, bounced_or_failed: 0, signed: 0, content_done: 0, paid: 0, total_spent: 0 },
  }));
  assert.equal(noBudget.campaign.budget_utilization, null);
});
