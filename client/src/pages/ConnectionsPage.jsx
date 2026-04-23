import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

/**
 * Platform connections + scheduled publishes overview.
 */
export default function ConnectionsPage() {
  const [platforms, setPlatforms] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [apiKeyModal, setApiKeyModal] = useState(null); // provider obj or null
  const [apiKeyValues, setApiKeyValues] = useState({});
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const { t } = useI18n();

  useEffect(() => { loadAll(); const iv = setInterval(loadAll, 15_000); return () => clearInterval(iv); }, []);

  async function loadAll() {
    try {
      const [p, s] = await Promise.all([
        api.listPublishPlatforms(),
        api.listScheduledPublishes({ limit: 50 }),
      ]);
      setPlatforms(p.platforms || []);
      setSchedules(s.items || []);
    } catch (e) { /* ok */ }
    setLoading(false);
  }

  async function handleConnect(platform) {
    const p = platforms.find(x => x.id === platform);
    if (p?.kind === 'api_key') {
      const initial = {};
      for (const f of (p.fields || [])) initial[f.name] = '';
      setApiKeyValues(initial);
      setApiKeyModal(p);
      return;
    }
    try {
      const r = await api.initOAuth(platform);
      window.open(r.authorize_url, '_blank', 'width=640,height=720');
      toast.info(t('connections.oauth_info'));
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        await loadAll();
        const p = platforms.find(x => x.id === platform);
        if ((p?.connection) || tries > 60) clearInterval(poll);
      }, 2000);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDisconnect(platform) {
    const ok = await confirmDialog(t('connections.confirm_disconnect', { platform }), { title: t('connections.disconnect_title'), danger: true, confirmText: t('connections.disconnect') });
    if (!ok) return;
    try {
      await api.disconnectPlatform(platform);
      toast.success(t('connections.disconnected'));
      loadAll();
    } catch (e) { toast.error(e.message); }
  }

  async function handleApiKeySubmit() {
    if (!apiKeyModal) return;
    for (const f of apiKeyModal.fields) {
      if (!apiKeyValues[f.name] || String(apiKeyValues[f.name]).trim() === '') {
        toast.error(t('connections.field_required', { label: f.label }));
        return;
      }
    }
    setApiKeySaving(true);
    try {
      const token = localStorage.getItem('influencex_token');
      const ws = window.__influencex_workspace_id;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (ws) headers['X-Workspace-Id'] = ws;
      const r = await fetch(`/api/publish/connect/${apiKeyModal.id}`, {
        method: 'POST', headers, body: JSON.stringify({ fields: apiKeyValues }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to connect');
      toast.success(t('connections.connected_msg', { platform: apiKeyModal.label, name: data.account_name }));
      setApiKeyModal(null);
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
    setApiKeySaving(false);
  }

  async function handleCancelSchedule(id) {
    const ok = await confirmDialog(t('connections.cancel_prompt'), { title: t('connections.cancel_title') });
    if (!ok) return;
    try {
      await api.cancelScheduledPublish(id);
      toast.success(t('connections.cancelled'));
      loadAll();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('connections.title')}</h2>
          <p>{t('connections.subtitle')}</p>
        </div>
      </div>

      {/* Platforms */}
      <div className="card">
        <h3 style={{ marginBottom: 14 }}>{t('connections.platforms')}</h3>
        {loading ? <div className="empty-state"><p>{t('common.loading')}</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {platforms.map(p => (
              <div key={p.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  {p.connection ? (
                    <span className="badge badge-green" style={{ fontSize: 10 }}>{t('connections.connected')}</span>
                  ) : p.configured ? (
                    <span className="badge badge-gray" style={{ fontSize: 10 }}>{t('connections.available')}</span>
                  ) : (
                    <span className="badge badge-orange" style={{ fontSize: 10 }}>{t('connections.needs_setup')}</span>
                  )}
                </div>
                {p.connection ? (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                      {p.connection.account_name || t('connections.connected')}
                      {p.connection.expires_at && (
                        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                          {t('connections.expires', { date: new Date(p.connection.expires_at).toLocaleDateString() })}
                        </span>
                      )}
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleDisconnect(p.id)}>{t('connections.disconnect')}</button>
                  </>
                ) : p.configured ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleConnect(p.id)}>
                    {t('connections.connect_cta', { platform: p.label })}
                  </button>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {t('connections.admin_setup')}
                  </div>
                )}
              </div>
            ))}
          </div>
        }
      </div>

      {/* Scheduled publishes */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('connections.scheduled', { count: schedules.length })}</h3>
        {schedules.length === 0 ? (
          <div className="empty-state"><p>{t('connections.scheduled_empty')}</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>{t('connections.col_content')}</th><th>{t('connections.col_platforms')}</th><th>{t('connections.col_when')}</th><th>{t('connections.col_status')}</th><th></th></tr></thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id}>
                    <td style={{ maxWidth: 340 }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.content_snapshot?.title || s.content_snapshot?.body?.slice(0, 80) || t('calendar.no_title')}
                      </div>
                    </td>
                    <td style={{ fontSize: 11 }}>
                      {(s.platforms || []).map(p => (
                        <span key={p} className="badge badge-gray" style={{ fontSize: 10, marginRight: 4 }}>{p}</span>
                      ))}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(s.scheduled_at).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${
                        s.status === 'complete' ? 'badge-green' :
                        s.status === 'error' ? 'badge-red' :
                        s.status === 'running' ? 'badge-orange' :
                        s.status === 'cancelled' ? 'badge-gray' : 'badge-purple'
                      }`}>{t(`calendar.status_${s.status}`)}</span>
                    </td>
                    <td>
                      {s.status === 'pending' && (
                        <button className="btn btn-sm btn-secondary" onClick={() => handleCancelSchedule(s.id)}>{t('common.cancel')}</button>
                      )}
                      {s.status === 'complete' && s.result?.results && (
                        <details style={{ fontSize: 12 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--accent)' }}>{t('connections.open_urls')}</summary>
                          <div style={{ marginTop: 6 }}>
                            {s.result.results.map(r => (
                              <div key={r.platform} style={{ marginBottom: 4 }}>
                                <a href={r.intent_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 11 }}>
                                  {r.platform} →
                                </a>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {apiKeyModal && (
        <div onClick={() => !apiKeySaving && setApiKeyModal(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{
            maxWidth: 480, width: '90%', padding: 24,
          }}>
            <h3 style={{ marginTop: 0 }}>{t('connections.api_key_modal_title', { platform: apiKeyModal.label })}</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              {t('connections.api_key_modal_help')}
            </p>
            {apiKeyModal.fields.map(f => (
              <div key={f.name} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {f.label}
                </label>
                <input
                  type={f.type === 'password' ? 'password' : 'text'}
                  value={apiKeyValues[f.name] || ''}
                  onChange={e => setApiKeyValues(v => ({ ...v, [f.name]: e.target.value }))}
                  className="form-input"
                  style={{ width: '100%' }}
                />
                {f.help && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{f.help}</div>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setApiKeyModal(null)} disabled={apiKeySaving}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleApiKeySubmit} disabled={apiKeySaving}>
                {apiKeySaving ? t('connections.api_key_connecting') : t('connections.connect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
