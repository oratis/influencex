import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';

const WORKFLOW_STEPS = [
  { key: 'email', label: 'Outreach', icon: '📧' },
  { key: 'contract', label: 'Contract', icon: '📝' },
  { key: 'content', label: 'Content', icon: '🎬' },
  { key: 'payment', label: 'Payment', icon: '💰' },
];

const CONTRACT_OPTIONS = [
  { value: 'none', label: 'Not Started', color: 'badge-gray' },
  { value: 'sent', label: 'Sent', color: 'badge-orange' },
  { value: 'signed', label: 'Signed', color: 'badge-green' },
  { value: 'declined', label: 'Declined', color: 'badge-red' },
];

const CONTENT_OPTIONS = [
  { value: 'not_started', label: 'Not Started', color: 'badge-gray' },
  { value: 'in_progress', label: 'In Progress', color: 'badge-orange' },
  { value: 'submitted', label: 'Submitted', color: 'badge-blue' },
  { value: 'approved', label: 'Approved', color: 'badge-green' },
  { value: 'revision', label: 'Needs Revision', color: 'badge-red' },
  { value: 'published', label: 'Published', color: 'badge-purple' },
];

const PAYMENT_OPTIONS = [
  { value: 'unpaid', label: 'Unpaid', color: 'badge-gray' },
  { value: 'pending', label: 'Pending', color: 'badge-orange' },
  { value: 'paid', label: 'Paid', color: 'badge-green' },
];

export default function ContactModule() {
  const { selectedCampaignId } = useCampaign();
  const [contacts, setContacts] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [loading, setLoading] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [threadData, setThreadData] = useState(null);

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
      alert(`Generated ${result.generated} emails!`);
      loadContacts();
    } catch (e) { alert('Error: ' + e.message); }
    setGenerating(false);
  };

  const handleSend = async (contactId) => {
    if (!confirm('Mark this email as sent?')) return;
    await api.sendEmail(contactId);
    loadContacts();
  };

  const handleWorkflowUpdate = async (contactId, field, value) => {
    await api.updateWorkflow(contactId, { [field]: value });
    loadContacts();
  };

  const handleSaveEdit = async () => {
    if (!editContact) return;
    await api.updateContact(editContact.id, {
      email_subject: editContact.email_subject,
      email_body: editContact.email_body,
      cooperation_type: editContact.cooperation_type,
      price_quote: editContact.price_quote,
      notes: editContact.notes,
    });
    setEditContact(null);
    loadContacts();
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
        <div className="page-header"><h2>Contact Center</h2><p>Select a campaign from the header to manage contacts</p></div>
        <div className="empty-state"><h4>No campaign selected</h4><p>Use the campaign selector in the header bar above</p></div>
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Contact Center</h2>
          <p>Manage outreach, contracts, content delivery, and payments</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={handleBatchGenerate} disabled={generating}>
            {generating ? '⏳ Generating...' : '🤖 Auto-Generate Emails'}
          </button>
        </div>
      </div>

      {/* Pipeline overview stats */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        <div className="stat-card"><div className="stat-icon orange">📧</div><div><div className="stat-value">{pipelineStats.drafts}</div><div className="stat-label">Drafts</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">📤</div><div><div className="stat-value">{pipelineStats.sent}</div><div className="stat-label">Sent</div></div></div>
        <div className="stat-card"><div className="stat-icon purple">💬</div><div><div className="stat-value">{pipelineStats.replied}</div><div className="stat-label">Replied</div></div></div>
        <div className="stat-card"><div className="stat-icon green">📝</div><div><div className="stat-value">{pipelineStats.contracted}</div><div className="stat-label">Contracted</div></div></div>
        <div className="stat-card"><div className="stat-icon blue">🎬</div><div><div className="stat-value">{pipelineStats.contentDone}</div><div className="stat-label">Content Done</div></div></div>
        <div className="stat-card"><div className="stat-icon green">💰</div><div><div className="stat-value">{pipelineStats.paid}</div><div className="stat-label">Paid</div></div></div>
      </div>

      <div className="tabs">
        {[
          { key: 'pipeline', label: `Pipeline (${contacts.length})` },
          { key: 'drafts', label: `Drafts (${pipelineStats.drafts})` },
          { key: 'sent', label: `Sent (${pipelineStats.sent})` },
          { key: 'replied', label: `Replied (${pipelineStats.replied})` },
          { key: 'in_progress', label: `In Progress (${pipelineStats.contracted})` },
        ].map(t => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading...</p></div>
      ) : filteredContacts.length === 0 ? (
        <div className="empty-state">
          <h4>No contacts yet</h4>
          <p>Click "Auto-Generate Emails" to create outreach emails for approved KOLs</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filteredContacts.map(contact => (
            <div key={contact.id} className="card" style={{ padding: '20px' }}>
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="kol-avatar"><img src={contact.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${contact.username}`} alt="" /></div>
                  <div>
                    <div style={{ fontWeight: '600', fontSize: '15px' }}>{contact.display_name || contact.username}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '2px' }}>
                      <span className="platform-icon"><span className={`platform-dot ${contact.platform}`} />{contact.platform}</span>
                      <span>{formatNumber(contact.followers)} followers</span>
                      <span>{contact.kol_email}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`badge ${contact.cooperation_type === 'affiliate' ? 'badge-purple' : 'badge-blue'}`}>
                    {contact.cooperation_type === 'affiliate' ? '🔗 Affiliate' : '💰 Paid'}
                  </span>
                  {contact.payment_amount > 0 && (
                    <span className="badge badge-gray">${contact.payment_amount}</span>
                  )}
                </div>
              </div>

              {/* Workflow pipeline */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                {/* Email Status */}
                <span className={`badge ${contact.status === 'sent' || contact.status === 'replied' ? 'badge-green' : contact.status === 'draft' ? 'badge-orange' : 'badge-gray'}`}>
                  📧 {contact.status === 'draft' ? 'Draft' : contact.status === 'sent' ? 'Sent' : contact.status === 'replied' ? 'Replied' : contact.status}
                </span>
                {/* Contract Status */}
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.contract_status || 'none'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'contract_status', e.target.value)}>
                  {CONTRACT_OPTIONS.map(o => <option key={o.value} value={o.value}>📝 {o.label}</option>)}
                </select>
                {/* Content Status */}
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.content_status || 'not_started'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'content_status', e.target.value)}>
                  {CONTENT_OPTIONS.map(o => <option key={o.value} value={o.value}>🎬 {o.label}</option>)}
                </select>
                {/* Payment Status */}
                <select className="form-select" style={{ width: 'auto', padding: '4px 28px 4px 8px', fontSize: '12px', minWidth: 0 }}
                  value={contact.payment_status || 'unpaid'}
                  onChange={e => handleWorkflowUpdate(contact.id, 'payment_status', e.target.value)}>
                  {PAYMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>💰 {o.label}</option>)}
                </select>
              </div>

              {/* Email content (collapsed by default in pipeline view) */}
              {(tab !== 'pipeline' || contact.status === 'draft') && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px' }}>Subject: {contact.email_subject}</div>
                  <div className="email-preview" style={{ maxHeight: '120px' }}>{contact.email_body}</div>
                </div>
              )}

              {/* Reply content */}
              {contact.status === 'replied' && contact.reply_content && (
                <div style={{ marginBottom: '12px', padding: '14px', background: 'var(--success-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(0,210,160,0.2)', cursor: 'pointer' }} onClick={() => handleViewThread(contact)}>
                  <div style={{ fontSize: '12px', color: 'var(--success)', fontWeight: '600', marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Reply received:</span>
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>Click to view full thread</span>
                  </div>
                  <div style={{ fontSize: '14px', whiteSpace: 'pre-wrap' }}>{contact.reply_content?.substring(0, 200)}{contact.reply_content?.length > 200 ? '...' : ''}</div>
                </div>
              )}

              {/* Content URL if submitted */}
              {contact.content_url && (
                <div style={{ marginBottom: '10px', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Content URL: </span>
                  <a href={contact.content_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{contact.content_url}</a>
                </div>
              )}

              {/* Actions */}
              <div className="btn-group">
                {contact.status === 'draft' && (
                  <>
                    <button className="btn btn-sm btn-secondary" onClick={() => setEditContact({ ...contact })}>✏️ Edit</button>
                    <button className="btn btn-sm btn-success" onClick={() => handleSend(contact.id)}>📤 Send</button>
                  </>
                )}
                {(contact.status === 'sent' || contact.status === 'replied') && (
                  <>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleViewThread(contact)}>📧 View Thread</button>
                    {contact.status === 'sent' && (
                      <button className="btn btn-sm btn-primary" onClick={() => {
                        const reply = prompt('Enter reply content:');
                        if (reply) api.recordReply(contact.id, reply).then(loadContacts);
                      }}>💬 Record Reply</button>
                    )}
                  </>
                )}
                {contact.content_status === 'not_started' && contact.contract_status === 'signed' && (
                  <button className="btn btn-sm btn-secondary" onClick={() => {
                    const url = prompt('Enter content URL:');
                    if (url) handleWorkflowUpdate(contact.id, 'content_url', url);
                  }}>🔗 Add Content URL</button>
                )}
                {contact.payment_status === 'unpaid' && contact.content_status === 'approved' && (
                  <button className="btn btn-sm btn-success" onClick={() => {
                    const amount = prompt('Payment amount ($):', contact.price_quote || '0');
                    if (amount) {
                      api.updateWorkflow(contact.id, { payment_amount: parseFloat(amount), payment_status: 'pending' }).then(loadContacts);
                    }
                  }}>💰 Process Payment</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Email Thread Modal */}
      {threadData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setThreadData(null)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>Email Thread</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  {threadData.contact?.display_name || threadData.contact?.username} ({threadData.contact?.kol_email})
                </p>
              </div>
              <button onClick={() => setThreadData(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
            </div>

            {(!threadData.thread || threadData.thread.length === 0) ? (
              <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                <p>No emails in thread yet.</p>
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
                          {msg.direction === 'outbound' ? 'SENT' : 'REPLY'}
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

      {/* Edit Modal */}
      {editContact && (
        <div className="modal-overlay" onClick={() => setEditContact(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '720px' }}>
            <div className="modal-header">
              <h3>Edit Email - {editContact.display_name || editContact.username}</h3>
              <button className="btn-icon" onClick={() => setEditContact(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Cooperation Type</label>
                  <select className="form-select" value={editContact.cooperation_type} onChange={e => setEditContact(c => ({ ...c, cooperation_type: e.target.value }))}>
                    <option value="affiliate">Affiliate Program</option>
                    <option value="paid">Paid Collaboration</option>
                  </select>
                </div>
                {editContact.cooperation_type === 'paid' && (
                  <div className="form-group">
                    <label className="form-label">Price Quote</label>
                    <input className="form-input" placeholder="e.g., $500 per video" value={editContact.price_quote || ''} onChange={e => setEditContact(c => ({ ...c, price_quote: e.target.value }))} />
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Subject</label>
                <input className="form-input" value={editContact.email_subject} onChange={e => setEditContact(c => ({ ...c, email_subject: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Email Body</label>
                <textarea className="form-textarea" style={{ minHeight: '250px' }} value={editContact.email_body} onChange={e => setEditContact(c => ({ ...c, email_body: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Internal Notes</label>
                <input className="form-input" placeholder="Notes for your team" value={editContact.notes || ''} onChange={e => setEditContact(c => ({ ...c, notes: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEditContact(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveEdit}>Save Changes</button>
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
