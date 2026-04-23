import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from './Toast';
import { useI18n } from '../i18n';

/**
 * Right-side drawer for managing a single contact's outreach.
 *
 * Two tabs:
 *   - thread: history of sent/received emails + delivery/open/bounce timeline
 *   - compose: template picker + variable preview + manual edit + send
 *
 * Props: { contact, campaignId, onClose, onChanged }
 *   contact: contact row from api.getContacts (must include id, display_name, kol_email, etc.)
 *   onChanged(): called whenever server state changes so parent can reload.
 */
export default function ContactThreadDrawer({ contact, campaignId, onClose, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState('compose');
  const [threadData, setThreadData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Compose state
  const [subject, setSubject] = useState(contact?.email_subject || '');
  const [body, setBody] = useState(contact?.email_body || '');
  const [toEmail, setToEmail] = useState(contact?.kol_email || '');
  const [templates, setTemplates] = useState({ builtin: [], custom: [] });
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(''); // ISO-ish local string from <input type="datetime-local">
  const [scheduling, setScheduling] = useState(false);
  const [mailboxes, setMailboxes] = useState([]);
  const [mailboxId, setMailboxId] = useState(contact?.mailbox_account_id || '');

  useEffect(() => {
    if (!contact?.id) return;
    setSubject(contact.email_subject || '');
    setBody(contact.email_body || '');
    setToEmail(contact.kol_email || '');
    setScheduledAt(contact.scheduled_send_at ? toLocalInputValue(contact.scheduled_send_at) : '');
    setMailboxId(contact.mailbox_account_id || '');
    setTab(contact.status === 'draft' || contact.status === 'scheduled' ? 'compose' : 'thread');
    loadThread();
    loadTemplates();
    loadMailboxes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.id]);

  async function loadMailboxes() {
    try {
      const r = await api.listMailboxes();
      setMailboxes(r.items || []);
    } catch (e) { /* ok */ }
  }

  async function loadThread() {
    if (!contact?.id) return;
    setLoading(true);
    try {
      const data = await api.getContactThread(contact.id);
      setThreadData(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function loadTemplates() {
    try {
      const data = await api.listAllEmailTemplates();
      setTemplates({ builtin: data.builtin || [], custom: data.custom || [] });
    } catch (e) { /* ok */ }
  }

  async function handleApplyTemplate() {
    if (!selectedTemplate) return;
    setRendering(true);
    try {
      // Check if it's a custom (DB) template — those have UUID ids and need
      // client-side render; or a built-in that goes through the server renderer.
      const isBuiltin = !!(templates.builtin || []).find(tp => tp.id === selectedTemplate);
      if (isBuiltin) {
        const r = await api.renderContactTemplate(contact.id, { template_id: selectedTemplate });
        setSubject(r.subject || '');
        setBody(r.body || '');
      } else {
        const tpl = (templates.custom || []).find(tp => tp.id === selectedTemplate);
        if (!tpl) return;
        // If this template has variants, let the server pick one and record
        // attribution so we can read A/B stats later. Otherwise just render.
        if (tpl.variant_count && tpl.variant_count > 0) {
          const picked = await api.pickTemplateVariant(contact.id, selectedTemplate);
          const vars = buildVariables(contact);
          setSubject(renderLocal(picked.chosen.subject, vars));
          setBody(renderLocal(picked.chosen.body, vars));
          if (picked.chosen.variant_label && picked.chosen.variant_label !== 'parent') {
            toast.info?.(t('contacts.drawer_picked_variant', { label: picked.chosen.variant_label }));
          }
        } else {
          // Still record template_id for future A/B stats, even if no variants yet.
          try { await api.pickTemplateVariant(contact.id, selectedTemplate); } catch {}
          const vars = buildVariables(contact);
          setSubject(renderLocal(tpl.subject, vars));
          setBody(renderLocal(tpl.body, vars));
        }
      }
    } catch (e) { toast.error(e.message); }
    setRendering(false);
  }

  async function handleSaveDraft() {
    setSaving(true);
    try {
      await api.updateContact(contact.id, {
        email_subject: subject,
        email_body: body,
        cooperation_type: contact.cooperation_type,
        price_quote: contact.price_quote,
        notes: contact.notes,
        mailbox_account_id: mailboxId || null,
      });
      toast.success(t('contacts.drawer_saved'));
      onChanged?.();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  }

  async function handleSendNow() {
    setSending(true);
    try {
      // Save first so the backend reads the latest subject/body.
      await api.updateContact(contact.id, {
        email_subject: subject,
        email_body: body,
        cooperation_type: contact.cooperation_type,
        price_quote: contact.price_quote,
        notes: contact.notes,
        mailbox_account_id: mailboxId || null,
      });
      await api.sendEmail(contact.id);
      toast.success(t('contacts.drawer_queued'));
      onChanged?.();
      setTab('thread');
    } catch (e) { toast.error(e.message); }
    setSending(false);
  }

  async function handleRetry() {
    try {
      await api.retryEmail(contact.id);
      toast.success(t('contacts.drawer_retrying'));
      onChanged?.();
    } catch (e) { toast.error(e.message); }
  }

  async function handleScheduleSend() {
    if (!scheduledAt) return;
    const iso = new Date(scheduledAt).toISOString();
    setScheduling(true);
    try {
      // Save the latest draft first so the scheduler picks up the current subject/body.
      await api.updateContact(contact.id, {
        email_subject: subject,
        email_body: body,
        cooperation_type: contact.cooperation_type,
        price_quote: contact.price_quote,
        notes: contact.notes,
      });
      await api.scheduleContact(contact.id, iso);
      toast.success(t('contacts.drawer_scheduled', { when: new Date(iso).toLocaleString() }));
      onChanged?.();
    } catch (e) { toast.error(e.message); }
    setScheduling(false);
  }

  async function handleCancelSchedule() {
    try {
      await api.cancelScheduledContact(contact.id);
      setScheduledAt('');
      toast.success(t('contacts.drawer_schedule_cancelled'));
      onChanged?.();
    } catch (e) { toast.error(e.message); }
  }

  const canSend = subject && body && toEmail && !sending;

  const combinedItems = useMemo(() => {
    if (!threadData) return [];
    const msgs = (threadData.thread || []).map(m => ({ kind: 'msg', ...m, when: m.sent_at }));
    const evs = (threadData.timeline || []).map(e => ({ kind: 'event', ...e, when: e.occurred_at }));
    return [...msgs, ...evs].sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0));
  }, [threadData]);

  if (!contact) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img alt="" src={contact.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${contact.username}`} style={{ width: 40, height: 40, borderRadius: '50%' }} />
            <div>
              <div style={{ fontWeight: 600 }}>{contact.display_name || contact.username}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{contact.kol_email || t('contacts.drawer_no_email')}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        <div className="tabs" style={{ padding: '0 22px', marginTop: 10 }}>
          <button className={`tab ${tab === 'compose' ? 'active' : ''}`} onClick={() => setTab('compose')}>{t('contacts.drawer_tab_compose')}</button>
          <button className={`tab ${tab === 'thread' ? 'active' : ''}`} onClick={() => setTab('thread')}>{t('contacts.drawer_tab_thread')}</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
          {tab === 'compose' && (
            <div>
              <div style={{ marginBottom: 14 }}>
                <EmailStatusBadge status={contact.status} t={t} />
                {contact.status === 'failed' && contact.send_error && (
                  <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 6, fontSize: 12 }}>
                    {contact.send_error}
                    <button className="btn btn-sm btn-secondary" style={{ marginLeft: 8 }} onClick={handleRetry}>{t('contacts.drawer_retry')}</button>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>{t('contacts.drawer_template')}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="form-select" style={{ flex: 1 }} value={selectedTemplate} onChange={e => setSelectedTemplate(e.target.value)}>
                    <option value="">{t('contacts.drawer_template_none')}</option>
                    {templates.custom.length > 0 && (
                      <optgroup label={t('contacts.drawer_template_custom')}>
                        {templates.custom.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                      </optgroup>
                    )}
                    <optgroup label={t('contacts.drawer_template_builtin')}>
                      {templates.builtin.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                    </optgroup>
                  </select>
                  <button className="btn btn-secondary btn-sm" disabled={!selectedTemplate || rendering} onClick={handleApplyTemplate}>
                    {rendering ? '…' : t('contacts.drawer_apply_template')}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t('contacts.drawer_template_hint')}</div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>{t('contacts.drawer_to')}</label>
                <input type="email" className="form-input" value={toEmail} onChange={e => setToEmail(e.target.value)} />
              </div>

              {mailboxes.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>{t('contacts.drawer_mailbox')}</label>
                  <select className="form-select" value={mailboxId} onChange={e => setMailboxId(e.target.value)}>
                    <option value="">{t('contacts.drawer_mailbox_default')}</option>
                    {mailboxes.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.provider.toUpperCase()} · {m.from_email}{m.is_default ? ` (${t('contacts.drawer_mailbox_default_tag')})` : ''}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const mb = mailboxes.find(m => m.id === mailboxId) || mailboxes.find(m => m.is_default);
                    if (mb && mb.provider === 'smtp') {
                      return (
                        <div style={{ fontSize: 11, color: 'var(--warning, #fdcb6e)', marginTop: 4 }}>
                          ⚠️ {t('contacts.drawer_mailbox_smtp_warn')}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>{t('contacts.email_subject_label')}</label>
                <input className="form-input" value={subject} onChange={e => setSubject(e.target.value)} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>{t('contacts.email_body_label')}</label>
                <textarea className="form-textarea" style={{ minHeight: 260 }} value={body} onChange={e => setBody(e.target.value)} />
              </div>

              <div style={{ padding: 12, background: 'var(--bg-elevated)', borderRadius: 6, marginBottom: 12 }}>
                <label style={labelStyle}>{t('contacts.drawer_schedule_label')}</label>
                {contact.scheduled_send_at ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="badge badge-purple">🕒 {new Date(contact.scheduled_send_at).toLocaleString()}</span>
                    <button className="btn btn-secondary btn-sm" onClick={handleCancelSchedule}>
                      {t('contacts.drawer_cancel_schedule')}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="datetime-local"
                      className="form-input"
                      style={{ flex: 1 }}
                      value={scheduledAt}
                      onChange={e => setScheduledAt(e.target.value)}
                      min={toLocalInputValue(new Date(Date.now() + 60 * 1000))}
                    />
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!scheduledAt || scheduling}
                      onClick={handleScheduleSend}
                    >
                      {scheduling ? '…' : `🕒 ${t('contacts.drawer_schedule_send')}`}
                    </button>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {t('contacts.drawer_schedule_hint')}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={handleSaveDraft} disabled={saving}>
                  {saving ? '…' : t('contacts.drawer_save_draft')}
                </button>
                <button className="btn btn-primary" onClick={handleSendNow} disabled={!canSend}>
                  {sending ? t('contacts.drawer_sending') : `📤 ${t('contacts.drawer_send_now')}`}
                </button>
              </div>
            </div>
          )}

          {tab === 'thread' && (
            <div>
              {threadData?.contact?.variant_info && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--bg-elevated)', borderRadius: 6, marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                  <span>🧪</span>
                  <span>{t('contacts.variant_sent_from', { template: threadData.contact.variant_info.template_name || 'template', label: threadData.contact.variant_info.variant_label || 'control' })}</span>
                </div>
              )}
              {loading ? <p style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</p> :
                combinedItems.length === 0 ? (
                  <div className="empty-state"><p>{t('contacts.thread_empty')}</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {combinedItems.map((it, i) => it.kind === 'msg' ? (
                      <ThreadMessage key={it.id || i} msg={it} t={t} />
                    ) : (
                      <TimelineEvent key={it.id || i} ev={it} t={t} />
                    ))}
                  </div>
                )
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', justifyContent: 'flex-end',
};
const drawerStyle = {
  width: 'min(640px, 100%)', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
  height: '100vh', display: 'flex', flexDirection: 'column',
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 };

function ThreadMessage({ msg, t }) {
  const outbound = msg.direction === 'outbound';
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: outbound ? 'rgba(108,92,231,0.10)' : 'rgba(0,210,160,0.10)',
      border: `1px solid ${outbound ? 'rgba(108,92,231,0.25)' : 'rgba(0,210,160,0.25)'}`,
      marginLeft: outbound ? 0 : 20, marginRight: outbound ? 20 : 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, color: '#fff', background: outbound ? '#6c5ce7' : '#00d2a0' }}>
          {outbound ? t('contacts.thread_sent') : t('contacts.thread_reply')}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{msg.sent_at ? new Date(msg.sent_at).toLocaleString() : ''}</span>
      </div>
      {msg.subject && <div style={{ fontWeight: 600, marginBottom: 4 }}>{msg.subject}</div>}
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{msg.body_text}</div>
    </div>
  );
}

function TimelineEvent({ ev, t }) {
  const icons = { sent: '📤', delivered: '📬', opened: '👀', clicked: '🖱️', bounced: '⚠️', complained: '🚫', failed: '❌' };
  const colors = { sent: 'var(--accent)', delivered: 'var(--success)', opened: '#6c5ce7', clicked: '#6c5ce7', bounced: 'var(--danger)', complained: 'var(--danger)', failed: 'var(--danger)' };
  const color = colors[ev.event_type] || 'var(--text-muted)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}>
      <span style={{ color }}>{icons[ev.event_type] || '•'}</span>
      <span style={{ color }}>{t(`contacts.event_${ev.event_type}`) || ev.event_type}</span>
      <span style={{ marginLeft: 'auto' }}>{ev.occurred_at ? new Date(ev.occurred_at).toLocaleString() : ''}</span>
    </div>
  );
}

export function EmailStatusBadge({ status, t }) {
  const statuses = {
    draft:      { color: 'badge-orange', icon: '📝' },
    pending:    { color: 'badge-orange', icon: '⏳' },
    sent:       { color: 'badge-blue',   icon: '📤' },
    delivered:  { color: 'badge-green',  icon: '📬' },
    opened:     { color: 'badge-purple', icon: '👀' },
    replied:    { color: 'badge-purple', icon: '💬' },
    bounced:    { color: 'badge-red',    icon: '⚠️' },
    failed:     { color: 'badge-red',    icon: '❌' },
  };
  const s = statuses[status] || { color: 'badge-gray', icon: '•' };
  return (
    <span className={`badge ${s.color}`}>{s.icon} {t(`contacts.email_status_${status}`) || status}</span>
  );
}

// --- helpers --------------------------------------------------------------

function buildVariables(contact) {
  return {
    kol_name: contact.display_name || contact.username,
    kol_handle: contact.username,
    platform: contact.platform || '',
    followers: formatFollowers(contact.followers),
    category: contact.category || '',
    cooperation_type: contact.cooperation_type || '',
    price_quote: contact.price_quote || '',
    sender_name: '',
    product_name: '',
    campaign_name: '',
  };
}

function formatFollowers(n) {
  if (!n && n !== 0) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function renderLocal(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// datetime-local inputs want "YYYY-MM-DDTHH:mm" in the user's timezone.
function toLocalInputValue(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
