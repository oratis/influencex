import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

export default function ContactModule() {
  const { t } = useI18n();
  const { selectedCampaignId } = useCampaign();
  const toast = useToast();
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirm();
  const [contacts, setContacts] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [loading, setLoading] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [threadData, setThreadData] = useState(null);

  const CONTRACT_OPTIONS = [
    { value: 'none', label: t('contacts.contract_none') },
    { value: 'sent', label: t('contacts.contract_sent') },
    { value: 'signed', label: t('contacts.contract_signed') },
    { value: 'declined', label: t('contacts.contract_declined') },
  ];
  const CONTENT_OPTIONS = [
    { value: 'not_started', label: t('contacts.content_not_started') },
    { value: 'in_progress', label: t('contacts.content_in_progress') },
    { value: 'submitted', label: t('contacts.content_submitted') },
    { value: 'approved', label: t('contacts.content_approved') },
    { value: 'revision', label: t('contacts.content_revision') },
    { value: 'published', label: t('contacts.content_published') },
  ];
  const PAYMENT_OPTIONS = [
    { value: 'unpaid', label: t('contacts.payment_unpaid') },
    { value: 'pending', label: t('contacts.payment_pending') },
    { value: 'paid', label: t('contacts.payment_paid') },
  ];

  useEffect(() => { if (selectedCampaignId) loadContacts(); else setContacts([]); }, [selectedCampaignId, tab]);

  const loadContacts = async () => {
    setLoading(true);
    try {
      const data = await api.getContacts(selectedCampaignId, {});
      setContacts(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleBatchGenerate = async () => {
    if (!selectedCampaignId) return;
    setGenerating(true);
    try {
      const result = await api.batchGenerateEmails(selectedCampaignId, { cooperation_type: 'affiliate' });
      toast.success(t('contacts.generated_msg', { count: result.generated }));
      loadContacts();
    } catch (e) { toast.error(e.message); }
    setGenerating(false);
  };

  const handleSend = async (contactId) => {
    const ok = await confirmDialog(t('contacts.confirm_send'), { title: t('contacts.confirm_send_title') });
    if (!ok) return;
    try {
      await api.sendEmail(contactId);
      toast.success(t('contacts.sent_toast'));
      loadContacts();
    } catch (e) { toast.error(e.message); }
  };

  const handleWorkflowUpdate = async (contactId, field, value) => {
    try {
      await api.updateWorkflow(contactId, { [field]: value });
      loadContacts();
    } catch (e) { toast.error(e.message); }
  };

  const handleSaveEdit = async () => {
    if (!editContact) return;
    try {
      await api.updateContact(editContact.id, {
        email_subject: editContact.email_subject,
        email_body: editContact.email_body,
        cooperation_type: editContact.cooperation_type,
        price_quote: editContact.price_quote,
        notes: editContact.notes,
      });
      toast.success(t('contacts.contact_updated'));
      setEditContact(null);
      loadContacts();
    } catch (e) { toast.error(e.message); }
  };

  const handleViewThread = async (contact) => {
    try {
      const data = await api.getContactThread(contact.id);
      setThreadData(data);
    } catch (e) { console.error(e); }
  };

  const filteredContacts = tab === 'pipeline' ? contacts :
    tab === 'drafts' ? contacts.filter(c => c.status === 'draft') :
    tab === 'sent' ? contacts.filter(c => c.status === 'sent') :
    tab === 'replied' ? contacts.filter(c => c.status === 'replied') :
    tab === 'in_progress' ? contacts.filter(c => c.contract_status === 'signed' || c.content_status !== 'not_started') :
    contacts;

  const pipelineStats = {
    drafts: contacts.filter(c => c.status === 'draft').length,
    sent: contacts.filter(c => c.status === 'sent').length,
    replied: contacts.filter(c => c.status === 'replied').length,
    contracted: contacts.filter(c => c.contract_status === 'signed').length,
    contentDone: contacts.filter(c => ['approved', 'published'].includes(c.content_status)).length,
    paid: contacts.filter(c => c.payment_status === 'paid').length,
  };

  if (!selectedCampaignId) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('contacts.title')}</h2><p>{t('contacts.no_campaign_sub')}</p></div>
        <div className="empty-state"><h4>{t('contacts.no_campaign_title')}</h4><p>{t('contacts.no_campaign_hint')}</p></div>
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>{t('contacts.title')}</h2>
          <p>{t('contacts.subtitle')}</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={handleBatchGenerate} disabled={generating}>
            {generating ? `⏳ ${t('contacts.generating')}` : `🤖 ${t('contacts.auto_generate')}`}
          </button>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        <div className="stat-card"><div className="stat-icon orange">📧</div><div><div className="stat-value">{pipelineStats.drafts}</div><div className="stat-label">{t('contacts.stat_drafts')}</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">📤</div><div><div className="stat-value">{pipelineStats.sent}</div><div className="stat-label">{t('contacts.stat_sent')}</div></div></div>
        <div className="stat-card"><div className="stat-icon purple">💬</div><div><div className="stat-value">{pipelineStats.replied}</div><div className="stat-label">{t('contacts.stat_replied')}</div></div></div>
        <div className="stat-card"><div className="stat-icon green">📝</div><div><div className="stat-value">{pipelineStats.contracted}</div><div className="stat-label">{t('contacts.stat_contracted')}</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">🎬</div><div><div className="stat-value">{pipelineStats.contentDone}</div><div className="stat-label">{t('contacts.stat_content_done')}</div></div></div>
        <div className="stat-card"><div className="stat-icon green">💰</div><div><div className="stat-value">{pipelineStats.paid}</div><div className="stat-label">{t('contacts.stat_paid')}</div></div></div>
      </div>

      <div className="tabs">
        {[
          { key: 'pipeline', label: t('contacts.tab_pipeline', { count: contacts.length }) },
          { key: 'drafts', label: t('contacts.tab_drafts', { count: pipelineStats.drafts }) },
          { key: 'sent', label: t('contacts.tab_sent', { count: pipelineStats.sent }) },
          { key: 'replied', label: t('contacts.tab_replied', { count: pipelineStats.replied }) },
          { key: 'in_progress', label: t('contacts.tab_in_progress', { count: pipelineStats.contracted }) },
        ].map(tt => (
          <button key={tt.key} className={`tab ${tab === tt.key ? 'active' : ''}`} onClick={() => setTab(tt.key)}>{tt.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state"><p>{t('contacts.loading')}</p></div>
      ) : filteredContacts.length === 0 ? (
        <div className="empty-state">
          <h4>{t('contacts.no_contacts')}</h4>
          <p>{t('contacts.no_contacts_hint')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filteredContacts.map(contact => (
            <div key={contact.id} className="card" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="kol-avatar"><img src={contact.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${contact.username}`} alt="" /></div>
                  <div>
                    <div style={{ fontWeight: '600', fontSize: '15px' }}>{contact.display_name || contact.username}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '2px' }}>
                      <span className="platform-icon"><span className={`platform-dot ${contact.platform}`} />{contact.platform}</span>
                      <span>{t('contacts.followers_suffix', { count: formatNumber(contact.followers) })}</span>
                      <span>{contact.kol_email}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`badge ${contact.cooperation_type === 'affiliate' ? 'badge-purple' : 'badge-blue'}`}>
                    {contact.cooperation_type === 'affiliate' ? `🔗 ${t('contacts.coop_affiliate')}` : `💰 ${t('contacts.coop_paid')}`}
                  </span>
                  {contact.payment_amount > 0 && (
                    <span className="badge badge-gray">${contact.payment_amount}</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                <span className={`badge ${contact.status === 'sent' || contact.status === 'replied' ? 'badge-green' : contact.status === 'draft' ? 'badge-orange' : 'badge-gray'}`}>
                  📧 {contact.status === 'draft' ? t('contacts.email_status_draft') : contact.status === 'sent' ? t('contacts.email_status_sent') : contact.status === 'replied' ? t('contacts.email_status_replied') : contact.status}
                </span>
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.contract_status || 'none'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'contract_status', e.target.value)}>
                  {CONTRACT_OPTIONS.map(o => <option key={o.value} value={o.value}>📝 {o.label}</option>)}
                </select>
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.content_status || 'not_started'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'content_status', e.target.value)}>
                  {CONTENT_OPTIONS.map(o => <option key={o.value} value={o.value}>🎬 {o.label}</option>)}
                </select>
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.payment_status || 'unpaid'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'payment_status', e.target.value)}>
                  {PAYMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>💰 {o.label}</option>)}
                </select>
              </div>

              {(tab !== 'pipeline' || contact.status === 'draft') && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px' }}>{t('contacts.subject_prefix', { subject: contact.email_subject })}</div>
                  <div className="email-preview" style={{ maxHeight: '120px' }}>{contact.email_body}</div>
                </div>
              )}

              {contact.status === 'replied' && contact.reply_content && (
                <div style={{ marginBottom: '12px', padding: '14px', background: 'var(--success-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(0,210,160,0.2)', cursor: 'pointer' }} onClick={() => handleViewThread(contact)}>
                  <div style={{ fontSize: '12px', color: 'var(--success)', fontWeight: '600', marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t('contacts.reply_received')}</span>
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>{t('contacts.reply_click_thread')}</span>
                  </div>
                  <div style={{ fontSize: '14px', whiteSpace: 'pre-wrap' }}>{contact.reply_content?.substring(0, 200)}{contact.reply_content?.length > 200 ? '...' : ''}</div>
                </div>
              )}

              {contact.content_url && (
                <div style={{ marginBottom: '10px', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('contacts.content_url_label')}</span>
                  <a href={contact.content_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{contact.content_url}</a>
                </div>
              )}

              <div className="btn-group">
                {contact.status === 'draft' && (
                  <>
                    <button className="btn btn-sm btn-secondary" onClick={() => setEditContact({ ...contact })}>✏️ {t('contacts.btn_edit')}</button>
                    <button className="btn btn-sm btn-success" onClick={() => handleSend(contact.id)}>📤 {t('contacts.btn_send')}</button>
                  </>
                )}
                {(contact.status === 'sent' || contact.status === 'replied') && (
                  <>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleViewThread(contact)}>📧 {t('contacts.btn_view_thread')}</button>
                    {contact.status === 'sent' && (
                      <button className="btn btn-sm btn-primary" onClick={async () => {
                        const reply = await promptDialog(t('contacts.prompt_reply'), { title: t('contacts.prompt_reply_title'), placeholder: t('contacts.prompt_reply_placeholder') });
                        if (reply) { await api.recordReply(contact.id, reply); toast.success(t('contacts.reply_recorded')); loadContacts(); }
                      }}>💬 {t('contacts.btn_record_reply')}</button>
                    )}
                  </>
                )}
                {contact.content_status === 'not_started' && contact.contract_status === 'signed' && (
                  <button className="btn btn-sm btn-secondary" onClick={async () => {
                    const url = await promptDialog(t('contacts.prompt_content_url'), { title: t('contacts.prompt_content_url_title'), placeholder: t('contacts.prompt_content_url_placeholder') });
                    if (url) handleWorkflowUpdate(contact.id, 'content_url', url);
                  }}>🔗 {t('contacts.btn_add_content_url')}</button>
                )}
                {contact.payment_status === 'unpaid' && contact.content_status === 'approved' && (
                  <button className="btn btn-sm btn-success" onClick={async () => {
                    const amount = await promptDialog(t('contacts.prompt_payment_amount'), { title: t('contacts.prompt_payment_title'), defaultValue: contact.price_quote || '0' });
                    if (amount) {
                      await api.updateWorkflow(contact.id, { payment_amount: parseFloat(amount), payment_status: 'pending' });
                      toast.success(t('contacts.payment_processed'));
                      loadContacts();
                    }
                  }}>💰 {t('contacts.btn_process_payment')}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {threadData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setThreadData(null)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>{t('contacts.thread_title')}</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  {threadData.contact?.display_name || threadData.contact?.username} ({threadData.contact?.kol_email})
                </p>
              </div>
              <button onClick={() => setThreadData(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
            </div>

            {(!threadData.thread || threadData.thread.length === 0) ? (
              <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                <p>{t('contacts.thread_empty')}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {threadData.thread.map((msg, i) => (
                  <div key={msg.id || i} style={{
                    padding: '14px 16px', borderRadius: '10px',
                    background: msg.direction === 'outbound' ? 'rgba(108,92,231,0.1)' : 'rgba(0,210,160,0.1)',
                    border: `1px solid ${msg.direction === 'outbound' ? 'rgba(108,92,231,0.25)' : 'rgba(0,210,160,0.25)'}`,
                    marginLeft: msg.direction === 'outbound' ? '0' : '24px',
                    marginRight: msg.direction === 'outbound' ? '24px' : '0',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', padding: '2px 6px',
                          borderRadius: '4px', color: '#fff',
                          background: msg.direction === 'outbound' ? '#6c5ce7' : '#00d2a0',
                        }}>
                          {msg.direction === 'outbound' ? t('contacts.thread_sent') : t('contacts.thread_reply')}
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{msg.from_email}</span>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {msg.sent_at ? new Date(msg.sent_at).toLocaleString() : ''}
                      </span>
                    </div>
                    {msg.subject && (
                      <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-primary)' }}>{msg.subject}</div>
                    )}
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>{msg.body_text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {editContact && (
        <div className="modal-overlay" onClick={() => setEditContact(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '720px' }}>
            <div className="modal-header">
              <h3>{t('contacts.edit_title', { name: editContact.display_name || editContact.username })}</h3>
              <button className="btn-icon" onClick={() => setEditContact(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('contacts.coop_type_label')}</label>
                  <select className="form-select" value={editContact.cooperation_type} onChange={e => setEditContact(c => ({ ...c, cooperation_type: e.target.value }))}>
                    <option value="affiliate">{t('contacts.coop_option_affiliate')}</option>
                    <option value="paid">{t('contacts.coop_option_paid')}</option>
                  </select>
                </div>
                {editContact.cooperation_type === 'paid' && (
                  <div className="form-group">
                    <label className="form-label">{t('contacts.price_quote')}</label>
                    <input className="form-input" placeholder={t('contacts.price_quote_placeholder')} value={editContact.price_quote || ''} onChange={e => setEditContact(c => ({ ...c, price_quote: e.target.value }))} />
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">{t('contacts.email_subject_label')}</label>
                <input className="form-input" value={editContact.email_subject} onChange={e => setEditContact(c => ({ ...c, email_subject: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('contacts.email_body_label')}</label>
                <textarea className="form-textarea" style={{ minHeight: '250px' }} value={editContact.email_body} onChange={e => setEditContact(c => ({ ...c, email_body: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('contacts.notes_label')}</label>
                <input className="form-input" placeholder={t('contacts.notes_placeholder')} value={editContact.notes || ''} onChange={e => setEditContact(c => ({ ...c, notes: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEditContact(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleSaveEdit}>{t('contacts.save_changes')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
