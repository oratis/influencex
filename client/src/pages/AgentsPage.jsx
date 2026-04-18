import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [runs, setRuns] = useState([]);
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [runningAgentId, setRunningAgentId] = useState(null);
  const [runInput, setRunInput] = useState('{}');
  const [activeRun, setActiveRun] = useState(null);
  const [events, setEvents] = useState([]);
  const toast = useToast();

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    try {
      const [a, r, c] = await Promise.all([
        api.listAgents(),
        api.listAgentRuns({ limit: 20 }),
        api.getAgentCostSummary(),
      ]);
      setAgents(a.agents || []);
      setRuns(r.runs || []);
      setCost(c);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function run(agentId, inputObj) {
    try {
      setRunningAgentId(null);
      setEvents([{ type: 'started', data: { agent: agentId }, timestamp: new Date().toISOString() }]);
      const r = await api.runAgent(agentId, inputObj);
      setActiveRun(r.runId);
      const src = api.streamAgentRun(r.runId);
      src.addEventListener('started', onEvt);
      src.addEventListener('progress', onEvt);
      src.addEventListener('partial', onEvt);
      src.addEventListener('thinking', onEvt);
      src.addEventListener('complete', onEvt);
      src.addEventListener('error', onEvt);
      src.addEventListener('closed', (e) => { src.close(); loadAll(); });

      function onEvt(e) {
        try {
          const parsed = JSON.parse(e.data);
          setEvents(evts => [...evts, { type: e.type, ...(parsed || {}) }]);
        } catch { setEvents(evts => [...evts, { type: e.type, raw: e.data }]); }
      }
    } catch (e) {
      toast.error(e.message);
    }
  }

  function formatMoney(cents) {
    if (cents == null) return '—';
    if (cents < 100) return `${cents}¢`;
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div><h2>Agents</h2><p>AI agents that do the work. Run one, watch events stream.</p></div>
      </div>

      {/* Cost summary */}
      {cost && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-icon purple">$</div>
            <div><div className="stat-value">{formatMoney(cost.lifetime?.usdCents)}</div><div className="stat-label">Lifetime spend</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon orange">T</div>
            <div><div className="stat-value">{formatMoney(cost.today?.usdCents)}</div><div className="stat-label">Today</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">R</div>
            <div><div className="stat-value">{cost.lifetime?.runs || 0}</div><div className="stat-label">Runs</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green">Tk</div>
            <div><div className="stat-value">{(cost.lifetime?.inputTokens || 0).toLocaleString()}</div><div className="stat-label">Tokens in</div></div>
          </div>
        </div>
      )}

      {/* Agent catalog */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h3>Available agents ({agents.length})</h3></div>
        {loading ? <div className="empty-state"><p>Loading...</p></div> :
          agents.length === 0 ? <div className="empty-state"><h4>No agents registered</h4><p>Agent runtime is available but no agents are registered in this build.</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {agents.map(a => (
              <div key={a.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>v{a.version} · {a.id}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => { setRunningAgentId(a.id); setRunInput(sampleInputFor(a)); }}>Run</button>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '6px 0', lineHeight: 1.4 }}>{a.description}</p>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(a.capabilities || []).map(cap => (
                    <span key={cap} className="badge badge-gray" style={{ fontSize: 10 }}>{cap}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        }
      </div>

      {/* Run modal */}
      {runningAgentId && (
        <div className="modal-overlay" onClick={() => setRunningAgentId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <div className="modal-header">
              <h3>Run: {runningAgentId}</h3>
              <button className="btn-icon" onClick={() => setRunningAgentId(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="form-label">Input (JSON)</label>
              <textarea
                className="form-textarea"
                value={runInput}
                onChange={e => setRunInput(e.target.value)}
                style={{ minHeight: 180, fontFamily: 'monospace', fontSize: 13 }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setRunningAgentId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                try {
                  const parsed = JSON.parse(runInput);
                  run(runningAgentId, parsed);
                } catch (e) {
                  toast.error('Invalid JSON: ' + e.message);
                }
              }}>Run</button>
            </div>
          </div>
        </div>
      )}

      {/* Live events for the active run */}
      {activeRun && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>Live run {activeRun.slice(0, 8)}…</h3>
            <button className="btn-icon" onClick={() => setActiveRun(null)}>✕</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-input)', borderRadius: 8, padding: 12 }}>
            {events.map((e, i) => (
              <div key={i} style={{ marginBottom: 4, color: e.type === 'error' ? 'var(--danger)' : e.type === 'complete' ? 'var(--success)' : 'var(--text-primary)' }}>
                <span style={{ opacity: 0.6 }}>[{e.type}]</span> {JSON.stringify(e.data || e, null, 0).slice(0, 200)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h3>Recent runs</h3></div>
        {runs.length === 0 ? <div className="empty-state"><p>No runs yet</p></div> :
          <div className="table-container">
            <table>
              <thead><tr><th>Agent</th><th>Status</th><th>Cost</th><th>Tokens</th><th>Duration</th><th>Started</th></tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td><code style={{ fontSize: 12 }}>{r.agent_id}</code></td>
                    <td><span className={`badge ${r.status === 'complete' ? 'badge-green' : r.status === 'error' ? 'badge-red' : 'badge-orange'}`}>{r.status}</span></td>
                    <td>{formatMoney(r.cost_usd_cents)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(r.input_tokens || 0) + '/' + (r.output_tokens || 0)}</td>
                    <td style={{ fontSize: 12 }}>{r.duration_ms ? `${r.duration_ms}ms` : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(r.started_at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  );
}

function sampleInputFor(agent) {
  const samples = {
    strategy: { brand_description: 'A SaaS platform helping indie devs track user analytics without ads' },
    research: { topic: 'AI content marketing for startups', audience: 'SaaS founders' },
    'content-text': { format: 'twitter', brief: 'Announce our new AI agents feature' },
    discovery: { keywords: 'gaming', min_subscribers: 10000, max_results: 20 },
  };
  return JSON.stringify(samples[agent.id] || { input: '...' }, null, 2);
}
