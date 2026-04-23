import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function AgentsPage() {
  const { t } = useI18n();
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
        <div><h2>{t('agents.title')}</h2><p>{t('agents.subtitle')}</p></div>
      </div>

      {cost && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat-card">
            <div className="stat-icon purple">$</div>
            <div><div className="stat-value">{formatMoney(cost.lifetime?.usdCents)}</div><div className="stat-label">{t('agents.stat_lifetime')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon orange">T</div>
            <div><div className="stat-value">{formatMoney(cost.today?.usdCents)}</div><div className="stat-label">{t('agents.stat_today')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">R</div>
            <div><div className="stat-value">{cost.lifetime?.runs || 0}</div><div className="stat-label">{t('agents.stat_runs')}</div></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green">Tk</div>
            <div><div className="stat-value">{(cost.lifetime?.inputTokens || 0).toLocaleString()}</div><div className="stat-label">{t('agents.stat_tokens')}</div></div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h3>{t('agents.catalog_title', { count: agents.length })}</h3></div>
        {loading ? <div className="empty-state"><p>{t('agents.loading')}</p></div> :
          agents.length === 0 ? <div className="empty-state"><h4>{t('agents.no_agents_title')}</h4><p>{t('agents.no_agents_hint')}</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {agents.map(a => (
              <div key={a.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('agents.version_line', { version: a.version, id: a.id })}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => { setRunningAgentId(a.id); setRunInput(sampleInputFor(a)); }}>{t('agents.run_btn')}</button>
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

      {runningAgentId && (
        <div className="modal-overlay" onClick={() => setRunningAgentId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <div className="modal-header">
              <h3>{t('agents.modal_title', { id: runningAgentId })}</h3>
              <button className="btn-icon" onClick={() => setRunningAgentId(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="form-label">{t('agents.modal_input_label')}</label>
              <textarea
                className="form-textarea"
                value={runInput}
                onChange={e => setRunInput(e.target.value)}
                style={{ minHeight: 180, fontFamily: 'monospace', fontSize: 13 }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setRunningAgentId(null)}>{t('agents.modal_cancel')}</button>
              <button className="btn btn-primary" onClick={() => {
                try {
                  const parsed = JSON.parse(runInput);
                  run(runningAgentId, parsed);
                } catch (e) {
                  toast.error(t('agents.invalid_json', { msg: e.message }));
                }
              }}>{t('agents.modal_run')}</button>
            </div>
          </div>
        </div>
      )}

      {activeRun && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>{t('agents.live_run_title', { id: activeRun.slice(0, 8) })}</h3>
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

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h3>{t('agents.recent_title')}</h3></div>
        {runs.length === 0 ? <div className="empty-state"><p>{t('agents.recent_empty')}</p></div> :
          <div className="table-container">
            <table>
              <thead><tr><th>{t('agents.col_agent')}</th><th>{t('agents.col_status')}</th><th>{t('agents.col_cost')}</th><th>{t('agents.col_tokens')}</th><th>{t('agents.col_duration')}</th><th>{t('agents.col_started')}</th></tr></thead>
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
    'content-text': { format: 'twitter', brief: 'Announce our new AI agents feature', tier: 'fast' },
    'content-visual': { brief: 'Minimalist isometric dashboard illustration, soft pastel palette', size: '2k', mode: 'direct' },
    'content-voice': { text: 'Welcome to the show. This week we look at AI marketing agents.' },
    'content-video': { brief: 'Announce our new content studio feature', platform: 'shorts', include_voiceover: false },
    publisher: { content: { title: 'Hi', body: 'Testing publisher', hashtags: ['demo'] }, platforms: ['twitter', 'linkedin'] },
    'kol-outreach': { campaign_id: 'REPLACE_WITH_CAMPAIGN_ID', min_ai_score: 50, max_drafts: 5 },
    discovery: { keywords: 'gaming', min_subscribers: 10000, max_results: 20 },
    seo: { topic: 'AI content marketing for indie SaaS', audience: 'SaaS founders' },
    'competitor-monitor': { competitors: ['HubSpot', 'Jasper', 'Buffer'], our_positioning: 'Open-source AI content platform', category: 'AI content marketing' },
    'review-miner': { product: 'InfluenceX', audience_context: 'SaaS founders' },
  };
  return JSON.stringify(samples[agent.id] || { input: '...' }, null, 2);
}
