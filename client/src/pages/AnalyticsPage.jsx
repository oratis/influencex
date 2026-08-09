import React, { useState, useEffect, useMemo, Suspense, lazy } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import ErrorCard from '../components/ErrorCard';

// recharts is heavy and this page is imported eagerly in App.jsx, so the chart
// lives behind a lazy boundary (same reason RoiDashboard is lazy).
const UsageChart = lazy(() => import('../components/UsageChart'));

const MONTH_WINDOWS = [3, 6, 12, 24];

export default function AnalyticsPage() {
  const { t } = useI18n();
  const [agents, setAgents] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [presets, setPresets] = useState([]);
  const [content, setContent] = useState({});
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Usage ledger (roadmap D5) — its own fetch so the month/agent filters can
  // reload it without re-fetching the whole dashboard.
  const [usage, setUsage] = useState(null);
  const [usageMonths, setUsageMonths] = useState(6);
  const [usageAgent, setUsageAgent] = useState('');
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState(null);

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { loadUsage(); }, [usageMonths, usageAgent]);

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
      setLoadError(null);
    } catch (e) {
      // Swallowing this rendered an empty dashboard that looked like
      // "no activity yet".
      setLoadError(e);
    }
    setLoading(false);
  }

  async function loadUsage() {
    setUsageLoading(true);
    try {
      const u = await api.getUsage({ months: usageMonths, agent: usageAgent || undefined });
      setUsage(u);
      setUsageError(null);
    } catch (e) {
      setUsageError(e);
    }
    setUsageLoading(false);
  }

  function money(cents) {
    if (cents == null) return '—';
    if (cents < 100) return `${cents}¢`;
    return `$${(cents / 100).toFixed(2)}`;
  }

  // design.md §12: show "—" rather than 0, so "nothing recorded" doesn't read
  // as a measured zero.
  function count(n) {
    return n ? Number(n).toLocaleString() : '—';
  }

  // Months newest-first, each with its agent cells. Only months that actually
  // have runs make the table (the chart keeps every month so its axis stays
  // continuous).
  const usageGroups = useMemo(() => {
    if (!usage) return [];
    const byMonth = new Map(usage.byMonth.map(m => [m.month, m]));
    const grouped = new Map();
    for (const cell of usage.rows) {
      if (!grouped.has(cell.month)) grouped.set(cell.month, []);
      grouped.get(cell.month).push(cell);
    }
    return [...grouped.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, cells]) => ({ month, cells, total: byMonth.get(month) || { runs: 0, input_tokens: 0, output_tokens: 0, usd_cents: 0 } }));
  }, [usage]);

  // The dropdown has to keep every option after a filter is applied, so it
  // reads the lifetime agent list rather than the (already filtered) window.
  const usageAgentOptions = useMemo(() => {
    const ids = new Set(agents.map(a => a.agent_id).filter(Boolean));
    for (const a of usage?.byAgent || []) if (a.agent_id) ids.add(a.agent_id);
    if (usageAgent) ids.add(usageAgent);
    return [...ids].sort();
  }, [agents, usage, usageAgent]);

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('analytics.title')}</h2>
          <p>{t('analytics.subtitle')}</p>
        </div>
      </div>

      {loadError && !cost && agents.length === 0 && platforms.length === 0 && (
        <ErrorCard error={loadError} onRetry={loadAll} />
      )}

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

      {/* ==================== Usage ledger (month × agent) ==================== */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>{t('usage.title')}</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{t('usage.subtitle')}</p>
          </div>
          {/* One filter row above everything it scopes — chart and table read
              the same slice. */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="usage-months">{t('usage.filter_window')}</label>
              <select
                id="usage-months"
                className="form-input"
                value={usageMonths}
                onChange={e => setUsageMonths(Number(e.target.value))}
                style={{ minWidth: 130 }}
              >
                {MONTH_WINDOWS.map(m => (
                  <option key={m} value={m}>{t('usage.window_months', { n: m })}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="usage-agent">{t('usage.filter_agent')}</label>
              <select
                id="usage-agent"
                className="form-input"
                value={usageAgent}
                onChange={e => setUsageAgent(e.target.value)}
                style={{ minWidth: 160 }}
              >
                <option value="">{t('usage.all_agents')}</option>
                {usageAgentOptions.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* A refetch that fails must say so rather than silently leaving stale
            numbers on screen, so the error renders above whatever we already
            have instead of replacing it. */}
        {usageError && usage && <ErrorCard error={usageError} onRetry={loadUsage} compact />}

        {usageError && !usage ? <ErrorCard error={usageError} onRetry={loadUsage} /> :
          usageLoading && !usage ? <div className="empty-state"><p>{t('analytics.loading')}</p></div> :
          !usage ? null :
          usage.total.runs === 0 ? (
            <div className="empty-state">
              <p>{t('usage.empty')}</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('usage.empty_hint')}</p>
            </div>
          ) : (
            // Hold the previous render at reduced opacity on refetch instead of
            // flashing a skeleton and jumping the layout.
            <div style={{ opacity: usageLoading ? 0.55 : 1, transition: 'opacity 0.15s' }}>
              <Suspense fallback={<div style={{ height: 260 }} />}>
                <UsageChart report={usage} />
              </Suspense>

              <div className="table-container" style={{ marginTop: 16 }}>
                {/* Equal-width digits so the token/cost columns line up down
                    the rows. */}
                <table style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <thead><tr>
                    <th>{t('usage.col_month')}</th>
                    <th>{t('usage.col_agent')}</th>
                    <th>{t('usage.col_calls')}</th>
                    <th>{t('usage.col_input_tokens')}</th>
                    <th>{t('usage.col_output_tokens')}</th>
                    <th>{t('usage.col_cost')}</th>
                  </tr></thead>
                  <tbody>
                    {usageGroups.map(g => (
                      <React.Fragment key={g.month}>
                        <tr style={{ background: 'var(--bg-card-hover)' }}>
                          <td style={{ fontWeight: 600 }}>{g.month}</td>
                          <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('usage.month_subtotal')}</td>
                          <td style={{ fontWeight: 600 }}>{count(g.total.runs)}</td>
                          <td style={{ fontWeight: 600 }}>{count(g.total.input_tokens)}</td>
                          <td style={{ fontWeight: 600 }}>{count(g.total.output_tokens)}</td>
                          <td style={{ fontWeight: 600 }}>{money(g.total.usd_cents)}</td>
                        </tr>
                        {g.cells.map(c => (
                          <tr key={`${g.month}-${c.agent_id}`}>
                            <td />
                            <td><code style={{ fontSize: 12 }}>{c.agent_id}</code></td>
                            <td>{count(c.runs)}</td>
                            <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{count(c.input_tokens)}</td>
                            <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{count(c.output_tokens)}</td>
                            <td>{money(c.usd_cents)}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--border)' }}>
                      <td style={{ fontWeight: 700 }}>{t('usage.total')}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {t('usage.total_agents', { n: usage.byAgent.length })}
                      </td>
                      <td style={{ fontWeight: 700 }}>{count(usage.total.runs)}</td>
                      <td style={{ fontWeight: 700 }}>{count(usage.total.input_tokens)}</td>
                      <td style={{ fontWeight: 700 }}>{count(usage.total.output_tokens)}</td>
                      <td style={{ fontWeight: 700 }}>{money(usage.total.usd_cents)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {usage.truncated && (
                <p style={{ fontSize: 12, color: 'var(--warning)', marginTop: 8 }}>{t('usage.truncated')}</p>
              )}
            </div>
          )
        }
      </div>

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
