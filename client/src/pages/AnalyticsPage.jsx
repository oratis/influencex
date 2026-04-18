import React, { useState, useEffect } from 'react';
import { api } from '../api/client';

/**
 * Analytics page — spend, agent performance, platform conversion, preset ROI.
 * All numbers are scoped to the current workspace.
 */
export default function AnalyticsPage() {
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
          <h2>Analytics</h2>
          <p>Understand where your AI spend goes and what's working.</p>
        </div>
      </div>

      {/* Cost summary */}
      {cost && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-icon purple">$</div>
            <div><div className="stat-value">{money(cost.lifetime?.usdCents)}</div><div className="stat-label">Lifetime spend</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon orange">T</div>
            <div><div className="stat-value">{money(cost.today?.usdCents)}</div><div className="stat-label">Today</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">R</div>
            <div><div className="stat-value">{cost.lifetime?.runs || 0}</div><div className="stat-label">Agent runs</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green">Tk</div>
            <div><div className="stat-value">{((cost.lifetime?.inputTokens || 0) + (cost.lifetime?.outputTokens || 0)).toLocaleString()}</div><div className="stat-label">Total tokens</div></div>
          </div>
        </div>
      )}

      {/* Agent performance */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Agent performance</h3>
        {loading ? <div className="empty-state"><p>Loading...</p></div> :
          agents.length === 0 ? <div className="empty-state"><p>Run an agent to see stats here.</p></div> :
          <div className="table-container">
            <table>
              <thead><tr>
                <th>Agent</th>
                <th>Runs</th>
                <th>Success rate</th>
                <th>Cost</th>
                <th>Avg cost/run</th>
                <th>Avg duration</th>
                <th>Tokens</th>
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

      {/* Platform performance */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Publishing conversion by platform</h3>
        {platforms.length === 0 ? <div className="empty-state"><p>Schedule some publishes to see platform stats.</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {platforms.map(p => (
              <div key={p.platform} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span className="badge badge-purple" style={{ textTransform: 'capitalize' }}>{p.platform}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.total} total</span>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-input)' }}>
                    <div style={{ width: `${(p.complete / p.total) * 100}%`, background: 'var(--success)' }} title={`${p.complete} complete`} />
                    <div style={{ width: `${(p.error / p.total) * 100}%`, background: 'var(--danger)' }} title={`${p.error} error`} />
                    <div style={{ width: `${(p.pending / p.total) * 100}%`, background: 'var(--warning)' }} title={`${p.pending} pending`} />
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  ✓ {p.complete || 0} · ✗ {p.error || 0} · ⏳ {p.pending || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {Math.round(p.successRate * 100)}% success
                </div>
              </div>
            ))}
          </div>
        }
      </div>

      {/* Preset effectiveness */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Prompt preset usage</h3>
        {presets.length === 0 ? <div className="empty-state"><p>Save presets in Content Studio to see usage here.</p></div> :
          <div className="table-container">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Agent</th><th>Uses</th><th>Created</th></tr></thead>
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

      {/* Content library breakdown */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Content library</h3>
        {Object.keys(content).length === 0 ? <div className="empty-state"><p>No saved content yet.</p></div> :
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
