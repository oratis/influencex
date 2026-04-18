import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

/**
 * Platform connections + scheduled publishes overview.
 */
export default function ConnectionsPage() {
  const [platforms, setPlatforms] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();

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
    try {
      const r = await api.initOAuth(platform);
      // Open in a new tab — callback writes to DB
      window.open(r.authorize_url, '_blank', 'width=640,height=720');
      toast.info('Complete the OAuth flow in the new window, then come back here.');
      // Poll until the connection appears
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
    const ok = await confirmDialog(`Disconnect ${platform}?`, { title: 'Disconnect', danger: true, confirmText: 'Disconnect' });
    if (!ok) return;
    try {
      await api.disconnectPlatform(platform);
      toast.success('Disconnected');
      loadAll();
    } catch (e) { toast.error(e.message); }
  }

  async function handleCancelSchedule(id) {
    const ok = await confirmDialog('Cancel this scheduled publish?', { title: 'Cancel schedule' });
    if (!ok) return;
    try {
      await api.cancelScheduledPublish(id);
      toast.success('Cancelled');
      loadAll();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Connections & Schedule</h2>
          <p>Connect your social accounts for direct publishing. Review scheduled posts below.</p>
        </div>
      </div>

      {/* Platforms */}
      <div className="card">
        <h3 style={{ marginBottom: 14 }}>Platforms</h3>
        {loading ? <div className="empty-state"><p>Loading...</p></div> :
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {platforms.map(p => (
              <div key={p.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  {p.connection ? (
                    <span className="badge badge-green" style={{ fontSize: 10 }}>connected</span>
                  ) : p.configured ? (
                    <span className="badge badge-gray" style={{ fontSize: 10 }}>available</span>
                  ) : (
                    <span className="badge badge-orange" style={{ fontSize: 10 }}>needs setup</span>
                  )}
                </div>
                {p.connection ? (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                      {p.connection.account_name || 'connected'}
                      {p.connection.expires_at && (
                        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                          expires {new Date(p.connection.expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleDisconnect(p.id)}>Disconnect</button>
                  </>
                ) : p.configured ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleConnect(p.id)}>
                    Connect {p.label}
                  </button>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Admin must configure OAuth client credentials in env vars.
                  </div>
                )}
              </div>
            ))}
          </div>
        }
      </div>

      {/* Scheduled publishes */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Scheduled publishes ({schedules.length})</h3>
        {schedules.length === 0 ? (
          <div className="empty-state"><p>No scheduled publishes. Create content in Studio and use the Schedule button.</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>Content</th><th>Platforms</th><th>When</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id}>
                    <td style={{ maxWidth: 340 }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.content_snapshot?.title || s.content_snapshot?.body?.slice(0, 80) || '(no title)'}
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
                      }`}>{s.status}</span>
                    </td>
                    <td>
                      {s.status === 'pending' && (
                        <button className="btn btn-sm btn-secondary" onClick={() => handleCancelSchedule(s.id)}>Cancel</button>
                      )}
                      {s.status === 'complete' && s.result?.results && (
                        <details style={{ fontSize: 12 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--accent)' }}>Open URLs</summary>
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
    </div>
  );
}
