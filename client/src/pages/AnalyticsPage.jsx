import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';

export default function AnalyticsPage() {
  const { t } = useI18n();
  const [agents, setAgents] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [presets, setPresets] = useState([]);
  const [content, setContent] = useState({});
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    try {
      const [a, p, pr, c, costR] = await Promise.all([
        api.getAgentAnalytics(),
        api.getPlatformAnalytics(),
        api.getPresetAnalytics(),
        api.getContentAnalytics(),
        api.getAgentCostSummary(),
      ]);
      setAgents(a.byAgent || []);
      setPlatforms(p.byPlatform || []);
      setPresets(pr.presets || []);
      setContent(c.byType || {});
      setCost(costR);
    } catch (e) { /* ok */ }
    setLoading(false);
  }

  function money(cents) {
    if (cents == null) return '—';
    if (cents < 100) return `${cents}¢`;
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('analytics.title')}</h2>
          <p>{t('analytics.subtitle')}</p>
        </div>
      </div>

      {cost && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-icon purple">$</div>
            <div><div className="stat-value">{money(cost.lifetime?.usdCents)}</div><div className="stat-label">{t('analytics.stat_lifetime')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon orange">T</div>
            <div><div className="stat-value">{money(cost.today?.usdCents)}</div><div className="stat-label">{t('analytics.stat_today')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">R</div>
            <div><div className="stat-value">{cost.lifetime?.runs || 0}</div><div className="stat-label">{t('analytics.stat_runs')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green">Tk</div>
            <div><div className="stat-value">{((cost.lifetime?.inputTokens || 0) + (cost.lifetime?.outputTokens || 0)).toLocaleString()}</div><div className="stat-label">{t('analytics.stat_tokens')}</div></div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('analytics.agent_performance')}</h3>
        {loading ? <div className="empty-state"><p>{t('analytics.loading')}</p></div> :
          agents.length === 0 ? <div className="empty-state"><p>{t('analytics.no_agents')}</p></div> :
          <div className="table-container">
            <table>
              <thead><tr>
                <th>{t('analytics.col_agent')}</th>
                <th>{t('analytics.col_runs')}</th>
                <th>{t('analytics.col_success_rate')}</th>
                <th>{t('analytics.col_cost')}</th>
                <th>{t('analytics.col_avg_cost')}</th>
                <th>{t('analytics.col_avg_duration')}</th>
                <th>{t('analytics.col_tokens')}</th>
              </tr></thead>
              <tbody>
                {agents.map(a => (
                  <tr key={a.agent_id}>
                    <td><code style={{ fontSize: 12 }}>{a.agent_id}</code></td>
                    <td>{a.total_runs}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 60, height: 6, background: 'var(--bg-input)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{
                            width: `${Math.round(a.success_rate * 100)}%`, height: '100%',
                            background: a.success_rate >= 0.9 ? 'var(--success)' : a.success_rate >= 0.5 ? 'var(--warning)' : 'var(--danger)',
                          }} />
                        </div>
                        <span style={{ fontSize: 12 }}>{Math.round(a.success_rate * 100)}%</span>
                      </div>
                    </td>
                    <td style={{ fontWeight: 600 }}>{money(a.total_usd_cents)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{money(Math.round(a.total_usd_cents / Math.max(1, a.total_runs)))}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.avg_duration_ms}ms</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {a.input_tokens.toLocaleString()} / {a.output_tokens.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('analytics.platform_title')}</h3>
        {platforms.length === 0 ? <div className="empty-state"><p>{t('analytics.no_platforms')}</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {platforms.map(p => (
              <div key={p.platform} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span className="badge badge-purple" style={{ textTransform: 'capitalize' }}>{p.platform}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('analytics.platform_total', { n: p.total })}</span>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-input)' }}>
                    <div style={{ width: `${(p.complete / p.total) * 100}%`, background: 'var(--success)' }} />
                    <div style={{ width: `${(p.error / p.total) * 100}%`, background: 'var(--danger)' }} />
                    <div style={{ width: `${(p.pending / p.total) * 100}%`, background: 'var(--warning)' }} />
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {t('analytics.platform_legend', { ok: p.complete || 0, err: p.error || 0, pend: p.pending || 0 })}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {t('analytics.platform_success_suffix', { pct: Math.round(p.successRate * 100) })}
                </div>
              </div>
            ))}
          </div>
        }
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('analytics.preset_title')}</h3>
        {presets.length === 0 ? <div className="empty-state"><p>{t('analytics.no_presets')}</p></div> :
          <div className="table-container">
            <table>
              <thead><tr>
                <th>{t('analytics.preset_col_name')}</th>
                <th>{t('analytics.preset_col_type')}</th>
                <th>{t('analytics.preset_col_agent')}</th>
                <th>{t('analytics.preset_col_uses')}</th>
                <th>{t('analytics.preset_col_created')}</th>
              </tr></thead>
              <tbody>
                {presets.map(p => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 500 }}>{p.name}</td>
                    <td><span className="badge badge-gray" style={{ fontSize: 10 }}>{p.type}</span></td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}><code>{p.agent_id || '—'}</code></td>
                    <td style={{ fontWeight: 600 }}>{p.use_count || 0}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('analytics.content_title')}</h3>
        {Object.keys(content).length === 0 ? <div className="empty-state"><p>{t('analytics.no_content')}</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {Object.entries(content).map(([type, statuses]) => {
              const total = Object.values(statuses).reduce((a, b) => a + b, 0);
              return (
                <div key={type} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 8, textTransform: 'capitalize' }}>{type}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>{total}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    {Object.entries(statuses).map(([s, c]) => `${s}: ${c}`).join(' · ')}
                  </div>
                </div>
              );
            })}
          </div>
        }
      </div>
    </div>
  );
}
