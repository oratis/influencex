import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

/**
 * Community Inbox — surfaces mentions/comments/DMs pulled by the Community
 * Agent. Three actions map 1:1 to the agent's actions:
 *   - Fetch: pulls new messages from connected platforms
 *   - Classify: runs triage on un-classified rows
 *   - Draft:  generates an on-brand reply for a selected message
 */
export default function CommunityInboxPage() {
  const [messages, setMessages] = useState([]);
  const [byStatus, setByStatus] = useState({});
  const [statusFilter, setStatusFilter] = useState('open');
  const [platformFilter, setPlatformFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [classifyBusy, setClassifyBusy] = useState(false);
  const toast = useToast();

  useEffect(() => { load(); }, [statusFilter, platformFilter]);

  async function load() {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (platformFilter) params.platform = platformFilter;
      const r = await api.listInboxMessages(params);
      setMessages(r.messages || []);
      setByStatus(r.by_status || {});
      if (selected && !(r.messages || []).some(m => m.id === selected.id)) setSelected(null);
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  }

  async function runAgent(action, extra = {}) {
    const r = await api.runAgent('community', { action, ...extra });
    // The run API is fire-and-forget; give the backend a moment then reload.
    await new Promise(res => setTimeout(res, 1200));
    return r;
  }

  async function handleFetch() {
    setFetchBusy(true);
    try {
      await runAgent('fetch');
      toast.success('Fetched latest mentions');
      await load();
    } catch (e) { toast.error(e.message); }
    setFetchBusy(false);
  }

  async function handleClassify() {
    setClassifyBusy(true);
    try {
      await runAgent('classify', { limit: 30 });
      toast.success('Classified new messages');
      await load();
    } catch (e) { toast.error(e.message); }
    setClassifyBusy(false);
  }

  async function handleDraft(msg) {
    setDraftBusy(true);
    try {
      await runAgent('draft', { inbox_message_id: msg.id });
      // Reload to pull the new draft_reply column.
      await load();
      const r = await api.listInboxMessages({ status: statusFilter, platform: platformFilter });
      const updated = (r.messages || []).find(m => m.id === msg.id);
      if (updated) setSelected(updated);
      toast.success('Draft generated');
    } catch (e) { toast.error(e.message); }
    setDraftBusy(false);
  }

  async function handleStatusChange(msg, newStatus) {
    try {
      await api.updateInboxMessage(msg.id, { status: newStatus });
      await load();
    } catch (e) { toast.error(e.message); }
  }

  async function handleDraftEdit(text) {
    if (!selected) return;
    setSelected({ ...selected, draft_reply: text });
  }

  async function handleDraftSave() {
    if (!selected) return;
    try {
      await api.updateInboxMessage(selected.id, { draft_reply: selected.draft_reply || '' });
      toast.success('Draft saved');
      load();
    } catch (e) { toast.error(e.message); }
  }

  const sentimentColor = {
    positive: '#10b981', neutral: '#6b7280', negative: '#f59e0b',
    hostile: '#ef4444', spam: '#9ca3af',
  };
  const priorityColor = { urgent: '#ef4444', normal: '#6b7280', low: '#9ca3af' };

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Community Inbox</h2>
          <p>Mentions, comments, and DMs from connected platforms — triaged by the Community Agent.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={handleClassify} disabled={classifyBusy}>
            {classifyBusy ? 'Classifying…' : 'Classify unread'}
          </button>
          <button className="btn btn-primary" onClick={handleFetch} disabled={fetchBusy}>
            {fetchBusy ? 'Fetching…' : 'Fetch new'}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatusChip label="Open" value={byStatus.open || 0} active={statusFilter === 'open'} onClick={() => setStatusFilter('open')} />
        <StatusChip label="Resolved" value={byStatus.resolved || 0} active={statusFilter === 'resolved'} onClick={() => setStatusFilter('resolved')} />
        <StatusChip label="Snoozed" value={byStatus.snoozed || 0} active={statusFilter === 'snoozed'} onClick={() => setStatusFilter('snoozed')} />
        <StatusChip label="All" value={Object.values(byStatus).reduce((a, b) => a + b, 0)} active={statusFilter === ''} onClick={() => setStatusFilter('')} />
      </div>

      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 16 }}>
        {/* Left: list */}
        <div className="card" style={{ padding: 0, maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value)} className="input" style={{ padding: '4px 8px' }}>
              <option value="">All platforms</option>
              <option value="twitter">X (Twitter)</option>
              <option value="linkedin">LinkedIn</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{messages.length} shown</span>
          </div>
          {loading ? (
            <div className="empty-state"><p>Loading…</p></div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <p>No messages match these filters.</p>
              <p style={{ fontSize: 12 }}>Connect a platform on <a href="/connections">Connections</a> and click "Fetch new".</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {messages.map(m => (
                <li
                  key={m.id}
                  onClick={() => setSelected(m)}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: selected?.id === m.id ? 'var(--surface-hover)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{m.author_handle || m.author_name || 'unknown'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{m.platform}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--text)', marginBottom: 6 }}>
                    {truncate(m.text, 140)}
                  </div>
                  <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                    {m.sentiment && (
                      <span style={{ color: sentimentColor[m.sentiment] || '#6b7280', fontWeight: 500 }}>● {m.sentiment}</span>
                    )}
                    {m.priority && m.priority !== 'normal' && (
                      <span style={{ color: priorityColor[m.priority], fontWeight: 500 }}>{m.priority}</span>
                    )}
                    <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                      {m.occurred_at ? new Date(m.occurred_at).toLocaleString() : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right: detail */}
        <div className="card" style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
          {!selected ? (
            <div className="empty-state">
              <p>Select a message to view details and draft a reply.</p>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                {selected.author_avatar_url && (
                  <img src={selected.author_avatar_url} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{selected.author_name || selected.author_handle || 'unknown'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {selected.author_handle} · {selected.platform} · {selected.kind}
                  </div>
                </div>
                {selected.url && (
                  <a href={selected.url} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ padding: '4px 10px' }}>
                    Open
                  </a>
                )}
              </div>

              <div style={{ background: 'var(--surface-hover)', padding: 12, borderRadius: 8, marginBottom: 16, whiteSpace: 'pre-wrap' }}>
                {selected.text}
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 12 }}>
                {selected.sentiment && (
                  <Badge color={sentimentColor[selected.sentiment]}>sentiment: {selected.sentiment}</Badge>
                )}
                {selected.priority && <Badge color={priorityColor[selected.priority]}>priority: {selected.priority}</Badge>}
                {(selected.tags || []).map(t => <Badge key={t} color="#6b7280">{t}</Badge>)}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Draft reply</label>
                  <button
                    onClick={() => handleDraft(selected)}
                    disabled={draftBusy}
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    {draftBusy ? 'Drafting…' : selected.draft_reply ? 'Regenerate' : 'Generate draft'}
                  </button>
                </div>
                <textarea
                  value={selected.draft_reply || ''}
                  onChange={e => handleDraftEdit(e.target.value)}
                  placeholder="Click 'Generate draft' to have the Community Agent write a reply."
                  rows={5}
                  className="input"
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" onClick={handleDraftSave}>Save draft</button>
                  {selected.status !== 'resolved' ? (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'resolved')}>
                      Mark resolved
                    </button>
                  ) : (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'open')}>
                      Reopen
                    </button>
                  )}
                  {selected.status !== 'snoozed' && (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'snoozed')}>
                      Snooze
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  The Community Agent doesn't auto-send. Copy the draft and post it on {selected.platform} yourself.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusChip({ label, value, active, onClick }) {
  return (
    <div
      className="stat-card"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        border: active ? '1px solid var(--primary)' : undefined,
        boxShadow: active ? '0 0 0 1px var(--primary)' : undefined,
      }}
    >
      <div className="stat-icon blue">{String(value)}</div>
      <div><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 11,
      color: '#fff',
      background: color || '#6b7280',
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
