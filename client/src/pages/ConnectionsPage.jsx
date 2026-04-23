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
  const [mailboxes, setMailboxes] = useState([]);
  const [envFallback, setEnvFallback] = useState(null);
  const [gmailConfigured, setGmailConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [apiKeyModal, setApiKeyModal] = useState(null); // provider obj or null
  const [apiKeyValues, setApiKeyValues] = useState({});
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [mailboxEditor, setMailboxEditor] = useState(null); // null | 'new' | mailbox row
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const { t } = useI18n();

  useEffect(() => { loadAll(); const iv = setInterval(loadAll, 15_000); return () => clearInterval(iv); }, []);

  async function loadAll() {
    try {
      const [p, s, m, g] = await Promise.all([
        api.listPublishPlatforms(),
        api.listScheduledPublishes({ limit: 50 }),
        api.listMailboxes().catch(() => ({ items: [], envFallback: null })),
        api.getGmailOAuthStatus().catch(() => ({ configured: false })),
      ]);
      setPlatforms(p.platforms || []);
      setSchedules(s.items || []);
      setMailboxes(m.items || []);
      setEnvFallback(m.envFallback || null);
      setGmailConfigured(!!g.configured);
    } catch (e) { /* ok */ }
    setLoading(false);
  }

  async function handleConnectGmail() {
    try {
      const r = await api.initGmailOAuth();
      window.open(r.url, 'gmail-oauth', 'width=520,height=700');
      // Listen for the callback postMessage so we can reload without the
      // user having to do anything.
      const onMsg = (e) => {
        if (e?.data?.type === 'gmail-oauth-complete') {
          window.removeEventListener('message', onMsg);
          toast.success(t('connections.mailbox_gmail_connected'));
          loadAll();
        }
      };
      window.addEventListener('message', onMsg);
      // Also re-poll after 45s in case the postMessage is blocked (cross-origin).
      setTimeout(() => { window.removeEventListener('message', onMsg); loadAll(); }, 45_000);
    } catch (e) { toast.error(e.message); }
  }

  async function handleSaveMailbox(form) {
    try {
      if (form.id && form.id !== 'new') {
        await api.updateMailbox(form.id, form);
      } else {
        await api.createMailbox(form);
      }
      toast.success(t('connections.mailbox_saved'));
      setMailboxEditor(null);
      loadAll();
    } catch (e) { toast.error(e.message); }
  }
  async function handleDeleteMailbox(id) {
    const ok = await confirmDialog(t('connections.mailbox_confirm_delete'), { title: t('connections.mailbox_delete_title'), danger: true });
    if (!ok) return;
    try {
      await api.deleteMailbox(id);
      toast.success(t('connections.mailbox_deleted'));
      loadAll();
    } catch (e) { toast.error(e.message); }
  }
  async function handleVerifyMailbox(id) {
    try {
      const r = await api.verifyMailbox(id);
      toast[r.verified ? 'success' : 'error'](r.verified ? t('connections.mailbox_verified') : (r.error || t('connections.mailbox_verify_failed')));
      loadAll();
    } catch (e) { toast.error(e.message); }
  }

  const [dnsResult, setDnsResult] = useState(null);
  async function handleDnsCheck(id) {
    try {
      const r = await api.dnsCheckMailbox(id);
      setDnsResult(r);
    } catch (e) { toast.error(e.message); }
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

      {/* Mailbox accounts */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{t('connections.mailbox_section')}</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleConnectGmail}
              disabled={!gmailConfigured}
              title={gmailConfigured ? '' : t('connections.mailbox_gmail_unconfigured')}
            >
              {gmailConfigured ? `✉️ ${t('connections.mailbox_gmail_connect')}` : `✉️ ${t('connections.mailbox_gmail_connect_needs_setup')}`}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setMailboxEditor('new')}>
              + {t('connections.mailbox_add')}
            </button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0 }}>{t('connections.mailbox_hint')}</p>

        {envFallback && !mailboxes.length && (envFallback.hasResend || envFallback.hasSmtp) && (
          <div className="card" style={{ padding: 12, marginBottom: 10, background: 'var(--bg-elevated)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('connections.mailbox_env_fallback', {
                provider: envFallback.hasResend ? 'Resend' : 'SMTP',
                email: envFallback.fromEmail || '(unset)',
              })}
            </div>
          </div>
        )}

        {mailboxes.length === 0 ? (
          <div className="empty-state" style={{ padding: 14, fontSize: 13 }}>
            <p>{t('connections.mailbox_empty')}</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {mailboxes.map(mb => (
              <div key={mb.id} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>
                    {mb.from_email}
                    {mb.is_default ? <span className="badge badge-purple" style={{ marginLeft: 6, fontSize: 10 }}>{t('connections.mailbox_default')}</span> : null}
                  </div>
                  <span className={`badge ${mb.status === 'active' ? 'badge-green' : 'badge-red'}`}>{mb.status}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {mb.provider.toUpperCase()} · {mb.from_name || t('connections.mailbox_no_name')}
                </div>
                {mb.last_error && (
                  <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 8 }}>{mb.last_error}</div>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => setMailboxEditor(mb)}>{t('common.edit')}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleVerifyMailbox(mb.id)}>{t('connections.mailbox_verify')}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleDnsCheck(mb.id)}>{t('connections.mailbox_dns_check')}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleDeleteMailbox(mb.id)}>{t('common.delete')}</button>
                </div>
              </div>
            ))}
          </div>
        )}
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

      {dnsResult && (
        <DnsCheckModal result={dnsResult} onClose={() => setDnsResult(null)} t={t} />
      )}

      {mailboxEditor && (
        <MailboxEditorModal
          mailbox={mailboxEditor === 'new' ? null : mailboxEditor}
          onCancel={() => setMailboxEditor(null)}
          onSave={handleSaveMailbox}
          t={t}
        />
      )}

      {apiKeyModal && (
        <div onClick={() => !apiKeySaving && setApiKeyModal(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* existing api-key modal contents */}
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

function DnsCheckModal({ result, onClose, t }) {
  const ok = result.spf.present && result.dmarc.present && Object.keys(result.dkim.found).length > 0;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 620, maxWidth: '92%', padding: 22, maxHeight: '85vh', overflow: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>
          {ok ? '✅' : '⚠️'} {t('connections.dns_check_title', { domain: result.domain })}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.dns_check_subtitle')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>SPF {result.spf.present ? '✅' : '❌'}</div>
            <pre style={{ fontSize: 11, background: 'var(--bg-elevated)', padding: 8, borderRadius: 4, overflow: 'auto', margin: '4px 0 0' }}>{result.spf.record || t('connections.dns_not_found')}</pre>
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>DKIM {Object.keys(result.dkim.found).length > 0 ? '✅' : '❌'}</div>
            {Object.entries(result.dkim.found).length > 0 ? (
              Object.entries(result.dkim.found).map(([sel, rec]) => (
                <div key={sel}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sel}._domainkey.{result.domain}</div>
                  <pre style={{ fontSize: 11, background: 'var(--bg-elevated)', padding: 8, borderRadius: 4, overflow: 'auto', margin: '2px 0 0' }}>{rec}</pre>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {t('connections.dns_checked_selectors', { selectors: result.dkim.selectors_checked.join(', ') })}
              </div>
            )}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>DMARC {result.dmarc.present ? '✅' : '❌'}</div>
            <pre style={{ fontSize: 11, background: 'var(--bg-elevated)', padding: 8, borderRadius: 4, overflow: 'auto', margin: '4px 0 0' }}>{result.dmarc.record || t('connections.dns_not_found')}</pre>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t('connections.dns_advice')}</div>
          <ul style={{ fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 18, margin: 0 }}>
            {result.advice.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}
          </ul>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={onClose}>{t('common.close') || 'Close'}</button>
        </div>
      </div>
    </div>
  );
}

function MailboxEditorModal({ mailbox, onCancel, onSave, t }) {
  const isEdit = !!mailbox?.id;
  const [form, setForm] = useState(() => ({
    id: mailbox?.id || 'new',
    provider: mailbox?.provider || 'resend',
    from_email: mailbox?.from_email || '',
    from_name: mailbox?.from_name || '',
    reply_to: mailbox?.reply_to || '',
    signature_html: mailbox?.signature_html || '',
    is_default: mailbox?.is_default || mailbox?.is_default === 1 || false,
    credentials: {
      api_key: '',
      smtp_host: mailbox?.credentials?.smtp_host || '',
      smtp_port: mailbox?.credentials?.smtp_port || 587,
      smtp_user: mailbox?.credentials?.smtp_user || '',
      smtp_pass: '',
    },
  }));

  const providerFields = form.provider === 'resend' ? (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_api_key')}</label>
      <input
        type="password"
        className="form-input"
        placeholder={isEdit ? t('connections.mailbox_api_key_edit_ph') : 're_xxx...'}
        value={form.credentials.api_key || ''}
        onChange={e => setForm(f => ({ ...f, credentials: { ...f.credentials, api_key: e.target.value } }))}
      />
      {isEdit && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t('connections.mailbox_api_key_help_edit')}</div>}
    </div>
  ) : (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 2 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>SMTP Host</label>
          <input className="form-input" value={form.credentials.smtp_host} onChange={e => setForm(f => ({ ...f, credentials: { ...f.credentials, smtp_host: e.target.value } }))} placeholder="smtp.gmail.com" />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Port</label>
          <input type="number" className="form-input" value={form.credentials.smtp_port} onChange={e => setForm(f => ({ ...f, credentials: { ...f.credentials, smtp_port: parseInt(e.target.value) || 587 } }))} />
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>SMTP User</label>
        <input className="form-input" value={form.credentials.smtp_user} onChange={e => setForm(f => ({ ...f, credentials: { ...f.credentials, smtp_user: e.target.value } }))} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>SMTP Password</label>
        <input type="password" className="form-input" placeholder={isEdit ? t('connections.mailbox_api_key_edit_ph') : ''} value={form.credentials.smtp_pass} onChange={e => setForm(f => ({ ...f, credentials: { ...f.credentials, smtp_pass: e.target.value } }))} />
      </div>
    </>
  );

  function submit() {
    // On edit with no new credential entered, strip empties so server keeps existing.
    const creds = { ...form.credentials };
    if (isEdit) {
      for (const k of Object.keys(creds)) {
        if (creds[k] === '' || creds[k] == null) delete creds[k];
      }
    }
    onSave({
      id: form.id,
      provider: form.provider,
      from_email: form.from_email,
      from_name: form.from_name,
      reply_to: form.reply_to || null,
      signature_html: form.signature_html || null,
      is_default: !!form.is_default,
      credentials: creds,
    });
  }

  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 520, maxWidth: '90%', padding: 20, maxHeight: '85vh', overflowY: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>{isEdit ? t('connections.mailbox_edit_title') : t('connections.mailbox_add_title')}</h3>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_provider')}</label>
          <select className="form-select" value={form.provider} disabled={isEdit} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
            <option value="resend">Resend</option>
            <option value="smtp">SMTP</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_from_email')}</label>
            <input type="email" className="form-input" value={form.from_email} onChange={e => setForm(f => ({ ...f, from_email: e.target.value }))} placeholder="you@yourdomain.com" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_from_name')}</label>
            <input className="form-input" value={form.from_name} onChange={e => setForm(f => ({ ...f, from_name: e.target.value }))} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_reply_to')}</label>
          <input type="email" className="form-input" value={form.reply_to} onChange={e => setForm(f => ({ ...f, reply_to: e.target.value }))} />
        </div>

        {providerFields}

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('connections.mailbox_signature')}</label>
          <textarea className="form-textarea" style={{ minHeight: 80 }} value={form.signature_html} onChange={e => setForm(f => ({ ...f, signature_html: e.target.value }))} placeholder="&lt;p&gt;Best,&lt;br/&gt;Team&lt;/p&gt;" />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 16 }}>
          <input type="checkbox" checked={form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} />
          {t('connections.mailbox_default_hint')}
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={!form.from_email}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
