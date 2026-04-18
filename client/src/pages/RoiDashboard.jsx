import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';

const FUNNEL_COLORS = ['#6c5ce7', '#74b9ff', '#00d2a0', '#fdcb6e', '#ff9ff3', '#00b894'];

function formatNumber(n) {
  if (!n && n !== 0) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatCurrency(v) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (isNaN(n)) return '-';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function MetricCard({ label, value, sub, color = 'var(--accent)' }) {
  return (
    <div className="stat-card" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
      <div className="stat-label" style={{ marginBottom: '6px' }}>{label}</div>
      <div className="stat-value" style={{ color, fontSize: '24px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

export default function RoiDashboard() {
  const { selectedCampaign, selectedCampaignId } = useCampaign();
  const [roi, setRoi] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    if (!selectedCampaignId) { setRoi(null); setLoading(false); return; }
    setLoading(true);
    api.getCampaignRoi(selectedCampaignId)
      .then(data => setRoi(data))
      .catch(e => toast.error('Failed to load ROI: ' + e.message))
      .finally(() => setLoading(false));
  }, [selectedCampaignId]);

  if (!selectedCampaignId) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>ROI Dashboard</h2><p>Select a campaign from the header to view ROI</p></div>
        <div className="empty-state"><h4>No campaign selected</h4><p>Use the campaign selector above</p></div>
      </div>
    );
  }

  if (loading || !roi) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>ROI Dashboard</h2></div>
        <div className="empty-state"><p>Loading ROI data...</p></div>
      </div>
    );
  }

  const { campaign, kols, funnel, content_performance: perf, roi: roiMetrics } = roi;
  const funnelSteps = [
    { label: 'Total Contacts', value: funnel.total_contacts, rate: '100%' },
    { label: 'Sent', value: funnel.sent_or_beyond, rate: funnel.total_contacts > 0 ? ((funnel.sent_or_beyond / funnel.total_contacts) * 100).toFixed(1) + '%' : '0%' },
    { label: 'Replied', value: funnel.replied, rate: funnel.rates.reply_rate + '%' },
    { label: 'Contracted', value: funnel.signed_contracts, rate: funnel.rates.contract_rate + '%' },
    { label: 'Content Done', value: funnel.content_done, rate: funnel.rates.completion_rate + '%' },
    { label: 'Paid', value: funnel.paid, rate: funnel.rates.payment_rate + '%' },
  ];

  const kolStatusData = Object.entries(kols.byStatus || {}).map(([status, data]) => ({
    status,
    count: data.count,
    avgScore: parseFloat(data.avgScore) || 0,
  }));

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>ROI Dashboard - {campaign.name}</h2>
          <p>Campaign performance, conversion funnel, and cost efficiency</p>
        </div>
        <div className="btn-group">
          <span className={`badge ${campaign.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{campaign.status}</span>
        </div>
      </div>

      {/* Top-line metrics */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <MetricCard
          label="Budget Utilization"
          value={campaign.budget_utilization ? campaign.budget_utilization + '%' : '-'}
          sub={`${formatCurrency(campaign.budget_spent)} / ${formatCurrency(campaign.budget)}`}
          color="#6c5ce7"
        />
        <MetricCard
          label="Total Content Views"
          value={formatNumber(perf.total_views)}
          sub={`${perf.content_count} pieces published`}
          color="#74b9ff"
        />
        <MetricCard
          label="Engagement Rate"
          value={perf.engagement_rate + '%'}
          sub={`${formatNumber(perf.total_engagement)} total interactions`}
          color="#00d2a0"
        />
        <MetricCard
          label="Effective CPM"
          value={roiMetrics.effective_cpm ? formatCurrency(roiMetrics.effective_cpm) : '-'}
          sub="Cost per 1,000 views"
          color="#fdcb6e"
        />
      </div>

      {/* Conversion Funnel */}
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-header">
          <h3>Conversion Funnel</h3>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>From outreach to paid content</span>
        </div>
        <div className="chart-container" style={{ height: '280px' }}>
          <ResponsiveContainer>
            <BarChart data={funnelSteps} layout="vertical" margin={{ left: 100 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis type="category" dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} width={100} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: '8px', fontSize: '13px'
                }}
                formatter={(v, name, props) => [`${v} (${props.payload.rate})`, 'Count']}
              />
              <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                {funnelSteps.map((_, i) => <Cell key={i} fill={FUNNEL_COLORS[i]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginTop: '16px' }}>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#6c5ce7' }}>{funnel.rates.reply_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Reply Rate</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#00d2a0' }}>{funnel.rates.contract_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Contract Rate</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#fdcb6e' }}>{funnel.rates.completion_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Completion Rate</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#00b894' }}>{funnel.rates.payment_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Payment Rate</div>
          </div>
        </div>
      </div>

      {/* KOL Status + ROI Details */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>
        <div className="card">
          <h3 style={{ marginBottom: '14px' }}>KOLs by Status</h3>
          {kolStatusData.length === 0 ? (
            <div className="empty-state"><p>No KOLs collected yet</p></div>
          ) : (
            <div className="chart-container" style={{ height: '220px' }}>
              <ResponsiveContainer>
                <BarChart data={kolStatusData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="status" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: '8px', fontSize: '13px'
                    }}
                  />
                  <Bar dataKey="count" fill="#6c5ce7" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '14px' }}>Cost Efficiency</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-input)', borderRadius: '8px' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Total Spent</div>
                <div style={{ fontSize: '22px', fontWeight: '700' }}>{formatCurrency(roiMetrics.total_spent)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Remaining</div>
                <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--success)' }}>{formatCurrency(campaign.budget_remaining)}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Cost per Signed Contract</div>
                <div style={{ fontSize: '18px', fontWeight: '700', color: '#74b9ff' }}>
                  {roiMetrics.cost_per_signed_contract ? formatCurrency(roiMetrics.cost_per_signed_contract) : '-'}
                </div>
              </div>
              <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Cost per Completed</div>
                <div style={{ fontSize: '18px', fontWeight: '700', color: '#00d2a0' }}>
                  {roiMetrics.cost_per_completed ? formatCurrency(roiMetrics.cost_per_completed) : '-'}
                </div>
              </div>
            </div>
            <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Effective CPM (cost per 1K views)</div>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#fdcb6e' }}>
                {roiMetrics.effective_cpm ? formatCurrency(roiMetrics.effective_cpm) : 'No views data yet'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content Performance Table */}
      <div className="card" style={{ marginTop: '16px' }}>
        <h3 style={{ marginBottom: '14px' }}>Content Performance Breakdown</h3>
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <MetricCard label="Pieces Published" value={perf.content_count} color="#6c5ce7" />
          <MetricCard label="Views" value={formatNumber(perf.total_views)} color="#74b9ff" />
          <MetricCard label="Likes" value={formatNumber(perf.total_likes)} color="#ff6b6b" />
          <MetricCard label="Comments" value={formatNumber(perf.total_comments)} color="#00d2a0" />
          <MetricCard label="Shares" value={formatNumber(perf.total_shares)} color="#fdcb6e" />
        </div>
      </div>
    </div>
  );
}
