import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';
import ContactThreadDrawer, { EmailStatusBadge } from '../components/ContactThreadDrawer';
import TemplateManagerDrawer from '../components/TemplateManagerDrawer';

export default function ContactModule() {
  const { t } = useI18n();
  const { selectedCampaignId } = useCampaign();
  const toast = useToast();
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirm();
  const [contacts, setContacts] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [drawerContact, setDrawerContact] = useState(null);
  const [templateMgrOpen, setTemplateMgrOpen] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkTemplateModal, setBulkTemplateModal] = useState(null);
  const [availableTemplates, setAvailableTemplates] = useState({ builtin: [], custom: [] });

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

  // Poll while anything is in flight so the UI reflects queue/delivery events.
  useEffect(() => {
    const hasInflight = contacts.some(c => c.status === 'pending' || c.status === 'sent');
    if (!hasInflight) return;
    const iv = setInterval(() => loadContacts(), 5000);
    return () => clearInterval(iv);
  }, [contacts]);

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

  const handleBulkSend = async () => {
    // Two gates: contacts with email+kol+not-already-sent are "strict" (can
    // send as-is); contacts without a draft body are "template-required"
    // (need a template to render a body for them). The modal handles both.
    const ids = Array.from(selectedIds);
    const eligibleIds = ids.filter(id => {
      const c = contacts.find(cc => cc.id === id);
      if (!c) return false;
      if (['sent', 'delivered', 'opened', 'replied'].includes(c.status)) return false;
      if (!c.kol_email) return false;
      return true;
    });
    if (eligibleIds.length === 0) {
      toast.error(t('contacts.bulk_send_no_eligible'));
      return;
    }
    // Load templates for the modal
    try {
      const data = await api.listAllEmailTemplates();
      setAvailableTemplates({ builtin: data.builtin || [], custom: data.custom || [] });
    } catch (e) { /* ok */ }
    setBulkTemplateModal({ ids: eligibleIds });
  };

  const handleBulkSendConfirm = async ({ ids, templateId }) => {
    setBulkSending(true);
    setBulkTemplateModal(null);
    try {
      const r = await api.batchSendEmails(selectedCampaignId, ids, templateId);
      toast.success(t('contacts.bulk_send_queued', { count: r.queued }));
      setSelectedIds(new Set());
      loadContacts();
    } catch (e) { toast.error(e.message); }
    setBulkSending(false);
  };

  const handleWorkflowUpdate = async (contactId, field, value) => {
    try {
      await api.updateWorkflow(contactId, { [field]: value });
      loadContacts();
    } catch (e) { toast.error(e.message); }
  };

  function toggleSelected(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAllFiltered() {
    const allIds = filteredContacts.map(c => c.id);
    const allSelected = allIds.every(id => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(allIds));
  }

  const isScheduled = c => !!c.scheduled_send_at && !c.sent_at;

  const filteredContacts = tab === 'pipeline' ? contacts :
    tab === 'drafts' ? contacts.filter(c => c.status === 'draft' && !isScheduled(c)) :
    tab === 'scheduled' ? contacts.filter(isScheduled) :
    tab === 'sent' ? contacts.filter(c => ['sent', 'delivered', 'opened'].includes(c.status)) :
    tab === 'replied' ? contacts.filter(c => c.status === 'replied') :
    tab === 'failed' ? contacts.filter(c => ['failed', 'bounced'].includes(c.status)) :
    tab === 'in_progress' ? contacts.filter(c => c.contract_status === 'signed' || c.content_status !== 'not_started') :
    contacts;

  const pipelineStats = {
    drafts: contacts.filter(c => c.status === 'draft' && !isScheduled(c)).length,
    scheduled: contacts.filter(isScheduled).length,
    sent: contacts.filter(c => ['sent', 'delivered', 'opened'].includes(c.status)).length,
    replied: contacts.filter(c => c.status === 'replied').length,
    contracted: contacts.filter(c => c.contract_status === 'signed').length,
    contentDone: contacts.filter(c => ['approved', 'published'].includes(c.content_status)).length,
    paid: contacts.filter(c => c.payment_status === 'paid').length,
    failed: contacts.filter(c => ['failed', 'bounced'].includes(c.status)).length,
  };

  if (!selectedCampaignId) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('contacts.title')}</h2><p>{t('contacts.no_campaign_sub')}</p></div>
        <div className="empty-state"><h4>{t('contacts.no_campaign_title')}</h4><p>{t('contacts.no_campaign_hint')}</p></div>
      </div>
    );
  }

  const eligibleSelectedCount = Array.from(selectedIds).filter(id => {
    const c = contacts.find(cc => cc.id === id);
    return c && c.kol_email && c.email_subject && c.email_body && !['sent', 'delivered', 'opened', 'replied'].includes(c.status);
  }).length;

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>{t('contacts.title')}</h2>
          <p>{t('contacts.subtitle')}</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={() => setTemplateMgrOpen(true)}>
            📝 {t('contacts.manage_templates')}
          </button>
          <button className="btn btn-primary" onClick={handleBatchGenerate} disabled={generating}>
            {generating ? `⏳ ${t('contacts.generating')}` : `🤖 ${t('contacts.auto_generate')}`}
          </button>
          <button
            className="btn btn-success"
            disabled={eligibleSelectedCount === 0 || bulkSending}
            onClick={handleBulkSend}
            title={eligibleSelectedCount === 0 ? t('contacts.bulk_send_hint') : ''}
          >
            {bulkSending ? '⏳' : '📤'} {t('contacts.bulk_send_button', { count: eligibleSelectedCount })}
          </button>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        <div className="stat-card"><div className="stat-icon orange">📧</div><div><div className="stat-value">{pipelineStats.drafts}</div><div className="stat-label">{t('contacts.stat_drafts')}</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">📤</div><div><div className="stat-value">{pipelineStats.sent}</div><div className="stat-label">{t('contacts.stat_sent')}</div></div></div>
        <div className="stat-card"><div className="stat-icon purple">💬</div><div><div className="stat-value">{pipelineStats.replied}</div><div className="stat-label">{t('contacts.stat_replied')}</div></div></div>
        <div className="stat-card"><div className="stat-icon red">⚠️</div><div><div className="stat-value">{pipelineStats.failed}</div><div className="stat-label">{t('contacts.stat_failed')}</div></div></div>
        <div className="stat-card"><div className="stat-icon green">📝</div><div><div className="stat-value">{pipelineStats.contracted}</div><div className="stat-label">{t('contacts.stat_contracted')}</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">🎬</div><div><div className="stat-value">{pipelineStats.contentDone}</div><div className="stat-label">{t('contacts.stat_content_done')}</div></div></div>
        <div className="stat-card"><div className="stat-icon green">💰</div><div><div className="stat-value">{pipelineStats.paid}</div><div className="stat-label">{t('contacts.stat_paid')}</div></div></div>
      </div>

      <div className="tabs">
        {[
          { key: 'pipeline', label: t('contacts.tab_pipeline', { count: contacts.length }) },
          { key: 'drafts', label: t('contacts.tab_drafts', { count: pipelineStats.drafts }) },
          { key: 'scheduled', label: t('contacts.tab_scheduled', { count: pipelineStats.scheduled }) },
          { key: 'sent', label: t('contacts.tab_sent', { count: pipelineStats.sent }) },
          { key: 'replied', label: t('contacts.tab_replied', { count: pipelineStats.replied }) },
          { key: 'failed', label: t('contacts.tab_failed', { count: pipelineStats.failed }) },
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
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filteredContacts.length > 0 && filteredContacts.every(c => selectedIds.has(c.id))}
                onChange={toggleSelectAllFiltered}
              />
              {t('contacts.select_all_visible', { count: filteredContacts.length })}
            </label>
            {selectedIds.size > 0 && (
              <span>· {t('contacts.selected_n', { count: selectedIds.size })}</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredContacts.map(contact => (
              <div key={contact.id} className="card" style={{ padding: '18px', border: selectedIds.has(contact.id) ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <input
                      type="checkbox"
                      style={{ marginTop: 4 }}
                      checked={selectedIds.has(contact.id)}
                      onChange={() => toggleSelected(contact.id)}
                    />
                    <div className="kol-avatar">
                      <img src={contact.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${contact.username}`} alt="" />
                    </div>
                    <div>
                      <div style={{ fontWeight: '600', fontSize: '15px' }}>{contact.display_name || contact.username}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '2px', flexWrap: 'wrap' }}>
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

                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <EmailStatusBadge status={contact.status} t={t} />
                  {contact.email_blocked_at && (
                    <span className="badge badge-red" title={contact.email_blocked_reason || ''}>
                      🚫 {t('contacts.email_blocked', { reason: (contact.email_blocked_reason || 'hard bounces').slice(0, 40) })}
                      <button
                        className="btn btn-sm"
                        style={{ marginLeft: 6, padding: '0 6px', fontSize: 10, background: 'transparent', border: '1px solid currentColor', color: 'inherit' }}
                        onClick={async () => {
                          try { await api.unblockKolEmail(contact.kol_row_id); toast.success(t('contacts.unblocked')); loadContacts(); }
                          catch (e) { toast.error(e.message); }
                        }}
                      >{t('contacts.unblock')}</button>
                    </span>
                  )}
                  {contact.scheduled_send_at && !contact.sent_at && (
                    <span className="badge badge-purple" title={new Date(contact.scheduled_send_at).toLocaleString()}>
                      🕒 {t('contacts.scheduled_for', { when: new Date(contact.scheduled_send_at).toLocaleString() })}
                    </span>
                  )}
                  {contact.last_opened_at && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      👀 {t('contacts.last_opened_at', { when: new Date(contact.last_opened_at).toLocaleString() })}
                    </span>
                  )}
                  {contact.reply_at && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      💬 {t('contacts.last_reply_at', { when: new Date(contact.reply_at).toLocaleString() })}
                    </span>
                  )}
                  {contact.send_error && contact.status === 'failed' && (
                    <span style={{ fontSize: 11, color: 'var(--danger)' }} title={contact.send_error}>
                      ⚠️ {contact.send_error.slice(0, 60)}{contact.send_error.length > 60 ? '…' : ''}
                    </span>
                  )}

                  <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0, marginLeft: 'auto' }}
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

                {(tab !== 'pipeline' || contact.status === 'draft') && contact.email_subject && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>{t('contacts.subject_prefix', { subject: contact.email_subject })}</div>
                    <div className="email-preview" style={{ maxHeight: '100px' }}>{contact.email_body}</div>
                  </div>
                )}

                {contact.status === 'replied' && contact.reply_content && (
                  <div style={{ marginBottom: '10px', padding: '12px', background: 'var(--success-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(0,210,160,0.2)', cursor: 'pointer' }} onClick={() => setDrawerContact(contact)}>
                    <div style={{ fontSize: '12px', color: 'var(--success)', fontWeight: '600', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{t('contacts.reply_received')}</span>
                      <span style={{ fontSize: '11px', opacity: 0.8 }}>{t('contacts.reply_click_thread')}</span>
                    </div>
                    <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{contact.reply_content?.substring(0, 200)}{contact.reply_content?.length > 200 ? '...' : ''}</div>
                  </div>
                )}

                {contact.content_url && (
                  <div style={{ marginBottom: '8px', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('contacts.content_url_label')}</span>
                    <a href={contact.content_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{contact.content_url}</a>
                  </div>
                )}

                <div className="btn-group">
                  <button className="btn btn-sm btn-primary" onClick={() => setDrawerContact(contact)}>
                    📧 {t('contacts.btn_open_thread')}
                  </button>
                  {contact.status === 'failed' && (
                    <button className="btn btn-sm btn-secondary" onClick={async () => {
                      try { await api.retryEmail(contact.id); toast.success(t('contacts.retrying_toast')); loadContacts(); }
                      catch (e) { toast.error(e.message); }
                    }}>🔁 {t('contacts.btn_retry')}</button>
                  )}
                  {contact.status === 'sent' && (
                    <button className="btn btn-sm btn-secondary" onClick={async () => {
                      const reply = await promptDialog(t('contacts.prompt_reply'), { title: t('contacts.prompt_reply_title'), placeholder: t('contacts.prompt_reply_placeholder') });
                      if (reply) { await api.recordReply(contact.id, reply); toast.success(t('contacts.reply_recorded')); loadContacts(); }
                    }}>💬 {t('contacts.btn_record_reply')}</button>
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
        </>
      )}

      {bulkTemplateModal && (
        <BulkSendModal
          ids={bulkTemplateModal.ids}
          contacts={contacts.filter(c => bulkTemplateModal.ids.includes(c.id))}
          templates={availableTemplates}
          onCancel={() => setBulkTemplateModal(null)}
          onConfirm={handleBulkSendConfirm}
          t={t}
        />
      )}

      {drawerContact && (
        <ContactThreadDrawer
          contact={drawerContact}
          campaignId={selectedCampaignId}
          onClose={() => setDrawerContact(null)}
          onChanged={() => { loadContacts(); }}
        />
      )}

      {templateMgrOpen && (
        <TemplateManagerDrawer onClose={() => setTemplateMgrOpen(false)} />
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

function BulkSendModal({ ids, contacts, templates, onCancel, onConfirm, t }) {
  const [templateId, setTemplateId] = useState('');
  const needsTemplate = contacts.some(c => !c.email_subject || !c.email_body);
  const withBody = contacts.filter(c => c.email_subject && c.email_body).length;
  const withoutBody = contacts.length - withBody;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div className="card" style={{ width: 520, maxWidth: '90%', padding: 22 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('contacts.bulk_send_title')}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {t('contacts.bulk_send_summary', { total: ids.length, withBody, withoutBody })}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('contacts.bulk_template_label')}
          </label>
          <select className="form-select" value={templateId} onChange={e => setTemplateId(e.target.value)}>
            <option value="">{t('contacts.bulk_template_none')}</option>
            {templates.custom.length > 0 && (
              <optgroup label={t('contacts.drawer_template_custom')}>
                {templates.custom.map(tp => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name}{tp.variant_count ? ` (${tp.variant_count} variants)` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={t('contacts.drawer_template_builtin')}>
              {templates.builtin.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
            </optgroup>
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {t('contacts.bulk_template_hint')}
          </div>
        </div>

        {needsTemplate && !templateId && (
          <div style={{ padding: 10, background: 'var(--warning-bg, rgba(253,203,110,0.1))', border: '1px solid rgba(253,203,110,0.3)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
            ⚠️ {t('contacts.bulk_send_template_required', { count: withoutBody })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            disabled={needsTemplate && !templateId}
            onClick={() => onConfirm({ ids, templateId: templateId || null })}
          >
            📤 {t('contacts.bulk_send_confirm_btn', { count: ids.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
