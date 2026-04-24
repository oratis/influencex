import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend } from 'recharts';
import { api, toastApiError } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import ErrorCard from '../components/ErrorCard';

const FUNNEL_COLORS = ['#6c5ce7', '#74b9ff', '#54a0ff', '#a29bfe', '#00d2a0', '#fdcb6e', '#ff9ff3', '#00b894'];

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
  const { t } = useI18n();
  const { selectedCampaign, selectedCampaignId } = useCampaign();
  const [roi, setRoi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const toast = useToast();

  const loadRoi = React.useCallback(() => {
    if (!selectedCampaignId) { setRoi(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    api.getCampaignRoi(selectedCampaignId)
      .then(data => { setRoi(data); setError(null); })
      .catch(e => {
        setError(e);
        toastApiError(e, toast, t);
      })
      .finally(() => setLoading(false));
  }, [selectedCampaignId, toast, t]);

  useEffect(() => { loadRoi(); }, [loadRoi]);

  if (!selectedCampaignId) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('roi.title')}</h2><p>{t('roi.subtitle_select')}</p></div>
        <div className="empty-state"><h4>{t('roi.no_campaign_title')}</h4><p>{t('roi.no_campaign_hint')}</p></div>
      </div>
    );
  }

  if (error && !roi) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('roi.title')}</h2></div>
        <ErrorCard error={error} onRetry={loadRoi} />
      </div>
    );
  }

  if (loading || !roi) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('roi.title')}</h2></div>
        <div className="empty-state"><p>{t('roi.loading')}</p></div>
      </div>
    );
  }

  const { campaign, kols, funnel, content_performance: perf, roi: roiMetrics, email_timeline: emailTimeline = [] } = roi;
  const funnelSteps = [
    { label: t('roi.funnel_total_contacts'), value: funnel.total_contacts, rate: '100%' },
    { label: t('roi.funnel_sent'), value: funnel.sent_or_beyond, rate: funnel.total_contacts > 0 ? ((funnel.sent_or_beyond / funnel.total_contacts) * 100).toFixed(1) + '%' : '0%' },
    { label: t('roi.funnel_delivered'), value: funnel.delivered ?? 0, rate: (funnel.rates.delivery_rate ?? '0.0') + '%' },
    { label: t('roi.funnel_opened'), value: funnel.opened ?? 0, rate: (funnel.rates.open_rate ?? '0.0') + '%' },
    { label: t('roi.funnel_replied'), value: funnel.replied, rate: funnel.rates.reply_rate + '%' },
    { label: t('roi.funnel_contracted'), value: funnel.signed_contracts, rate: funnel.rates.contract_rate + '%' },
    { label: t('roi.funnel_content_done'), value: funnel.content_done, rate: funnel.rates.completion_rate + '%' },
    { label: t('roi.funnel_paid'), value: funnel.paid, rate: funnel.rates.payment_rate + '%' },
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
          <h2>{t('roi.title_for', { name: campaign.name })}</h2>
          <p>{t('roi.subtitle')}</p>
        </div>
        <div className="btn-group">
          <span className={`badge ${campaign.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{campaign.status}</span>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <MetricCard
          label={t('roi.metric_budget_util')}
          value={campaign.budget_utilization ? campaign.budget_utilization + '%' : '-'}
          sub={`${formatCurrency(campaign.budget_spent)} / ${formatCurrency(campaign.budget)}`}
          color="#6c5ce7"
        />
        <MetricCard
          label={t('roi.metric_total_views')}
          value={formatNumber(perf.total_views)}
          sub={t('roi.pieces_published_sub', { n: perf.content_count })}
          color="#74b9ff"
        />
        <MetricCard
          label={t('roi.metric_engagement_rate')}
          value={perf.engagement_rate + '%'}
          sub={t('roi.total_interactions_sub', { n: formatNumber(perf.total_engagement) })}
          color="#00d2a0"
        />
        <MetricCard
          label={t('roi.metric_effective_cpm')}
          value={roiMetrics.effective_cpm ? formatCurrency(roiMetrics.effective_cpm) : '-'}
          sub={t('roi.cpm_sub')}
          color="#fdcb6e"
        />
      </div>

      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-header">
          <h3>{t('roi.funnel_title')}</h3>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('roi.funnel_subtitle')}</span>
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
                formatter={(v, name, props) => [`${v} (${props.payload.rate})`, t('roi.funnel_tooltip_label')]}
              />
              <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                {funnelSteps.map((_, i) => <Cell key={i} fill={FUNNEL_COLORS[i]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '10px', marginTop: '16px' }}>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#74b9ff' }}>{funnel.rates.delivery_rate ?? '0.0'}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.delivery_rate')}</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#a29bfe' }}>{funnel.rates.open_rate ?? '0.0'}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.open_rate')}</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#6c5ce7' }}>{funnel.rates.reply_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.reply_rate')}</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#00d2a0' }}>{funnel.rates.contract_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.contract_rate')}</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#fdcb6e' }}>{funnel.rates.completion_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.completion_rate')}</div>
          </div>
          <div className="card" style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#00b894' }}>{funnel.rates.payment_rate}%</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.payment_rate')}</div>
          </div>
        </div>
      </div>

      {emailTimeline.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>{t('roi.email_timeline_title')}</h3>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('roi.email_timeline_subtitle')}</span>
          </div>
          <div className="chart-container" style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={emailTimeline}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="sent" stroke="#6c5ce7" strokeWidth={2} dot={{ r: 3 }} name={t('roi.funnel_sent')} />
                <Line type="monotone" dataKey="delivered" stroke="#74b9ff" strokeWidth={2} dot={{ r: 3 }} name={t('roi.funnel_delivered')} />
                <Line type="monotone" dataKey="opened" stroke="#a29bfe" strokeWidth={2} dot={{ r: 3 }} name={t('roi.funnel_opened')} />
                <Line type="monotone" dataKey="replied" stroke="#00d2a0" strokeWidth={2} dot={{ r: 3 }} name={t('roi.funnel_replied')} />
                <Line type="monotone" dataKey="failed" stroke="#ff6b6b" strokeWidth={2} dot={{ r: 3 }} name={t('roi.funnel_failed')} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>
        <div className="card">
          <h3 style={{ marginBottom: '14px' }}>{t('roi.kols_by_status')}</h3>
          {kolStatusData.length === 0 ? (
            <div className="empty-state"><p>{t('roi.no_kols')}</p></div>
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
          <h3 style={{ marginBottom: '14px' }}>{t('roi.cost_efficiency')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-input)', borderRadius: '8px' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('roi.total_spent')}</div>
                <div style={{ fontSize: '22px', fontWeight: '700' }}>{formatCurrency(roiMetrics.total_spent)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('roi.remaining')}</div>
                <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--success)' }}>{formatCurrency(campaign.budget_remaining)}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.cost_per_signed')}</div>
                <div style={{ fontSize: '18px', fontWeight: '700', color: '#74b9ff' }}>
                  {roiMetrics.cost_per_signed_contract ? formatCurrency(roiMetrics.cost_per_signed_contract) : '-'}
                </div>
              </div>
              <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.cost_per_completed')}</div>
                <div style={{ fontSize: '18px', fontWeight: '700', color: '#00d2a0' }}>
                  {roiMetrics.cost_per_completed ? formatCurrency(roiMetrics.cost_per_completed) : '-'}
                </div>
              </div>
            </div>
            <div style={{ padding: '10px', background: 'var(--bg-input)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('roi.cpm_label')}</div>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#fdcb6e' }}>
                {roiMetrics.effective_cpm ? formatCurrency(roiMetrics.effective_cpm) : t('roi.no_views_data')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '16px' }}>
        <h3 style={{ marginBottom: '14px' }}>{t('roi.content_perf_title')}</h3>
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <MetricCard label={t('roi.pieces_published')} value={perf.content_count} color="#6c5ce7" />
          <MetricCard label={t('roi.views')} value={formatNumber(perf.total_views)} color="#74b9ff" />
          <MetricCard label={t('roi.likes')} value={formatNumber(perf.total_likes)} color="#ff6b6b" />
          <MetricCard label={t('roi.comments')} value={formatNumber(perf.total_comments)} color="#00d2a0" />
          <MetricCard label={t('roi.shares')} value={formatNumber(perf.total_shares)} color="#fdcb6e" />
        </div>
      </div>
    </div>
  );
}
