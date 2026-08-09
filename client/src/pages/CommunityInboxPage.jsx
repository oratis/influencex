import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n, enumLabel } from '../i18n';
import Modal from '../components/Modal';
import FormField from '../components/FormField';

export default function CommunityInboxPage() {
  const { t } = useI18n();
  const [messages, setMessages] = useState([]);
  const [byStatus, setByStatus] = useState({});
  const [statusFilter, setStatusFilter] = useState('open');
  const [platformFilter, setPlatformFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [showApifySync, setShowApifySync] = useState(false);
  const [apifyPlatform, setApifyPlatform] = useState('instagram');
  const [apifyUrls, setApifyUrls] = useState('');
  const [apifyBusy, setApifyBusy] = useState(false);
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
    await new Promise(res => setTimeout(res, 1200));
    return r;
  }

  async function handleFetch() {
    setFetchBusy(true);
    try {
      await runAgent('fetch');
      toast.success(t('inbox.toast_fetched'));
      await load();
    } catch (e) { toast.error(e.message); }
    setFetchBusy(false);
  }

  async function handleApifySync() {
    const urls = apifyUrls.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) { toast.warning(t('inbox.apify_sync_urls_required')); return; }
    setApifyBusy(true);
    try {
      const r = await api.syncInboxFromApify({ platform: apifyPlatform, urls, limit_per: 50 });
      toast.success(t('inbox.apify_sync_done', { inserted: r.inserted, skipped: r.skipped }));
      setShowApifySync(false);
      setApifyUrls('');
      await load();
    } catch (e) {
      toast.error(e.message);
    }
    setApifyBusy(false);
  }

  async function handleClassify() {
    setClassifyBusy(true);
    try {
      await runAgent('classify', { limit: 30 });
      toast.success(t('inbox.toast_classified'));
      await load();
    } catch (e) { toast.error(e.message); }
    setClassifyBusy(false);
  }

  async function handleDraft(msg) {
    setDraftBusy(true);
    try {
      await runAgent('draft', { inbox_message_id: msg.id });
      await load();
      const r = await api.listInboxMessages({ status: statusFilter, platform: platformFilter });
      const updated = (r.messages || []).find(m => m.id === msg.id);
      if (updated) setSelected(updated);
      toast.success(t('inbox.toast_draft_gen'));
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
      toast.success(t('inbox.toast_draft_saved'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  // Reuse the shared status tokens rather than a private hex palette
  // (design.md §0 / §2.3).
  const sentimentColor = {
    positive: 'var(--success)',
    neutral: 'var(--text-secondary)',
    negative: 'var(--warning)',
    hostile: 'var(--danger)',
    spam: 'var(--text-muted)',
  };
  const sentimentBadge = {
    positive: 'badge-green', neutral: 'badge-gray', negative: 'badge-orange',
    hostile: 'badge-red', spam: 'badge-gray',
  };
  const priorityColor = {
    urgent: 'var(--danger)', normal: 'var(--text-secondary)', low: 'var(--text-muted)',
  };
  const priorityBadge = { urgent: 'badge-red', normal: 'badge-gray', low: 'badge-gray' };

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('inbox.title')}</h2>
          <p>{t('inbox.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowApifySync(true)}>
            {t('inbox.btn_apify_sync')}
          </button>
          <button className="btn btn-secondary" onClick={handleClassify} disabled={classifyBusy}>
            {classifyBusy ? t('inbox.btn_classifying') : t('inbox.btn_classify')}
          </button>
          <button className="btn btn-primary" onClick={handleFetch} disabled={fetchBusy}>
            {fetchBusy ? t('inbox.btn_fetching') : t('inbox.btn_fetch')}
          </button>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatusChip label={t('inbox.status_open')} value={byStatus.open || 0} active={statusFilter === 'open'} onClick={() => setStatusFilter('open')} />
        <StatusChip label={t('inbox.status_resolved')} value={byStatus.resolved || 0} active={statusFilter === 'resolved'} onClick={() => setStatusFilter('resolved')} />
        <StatusChip label={t('inbox.status_snoozed')} value={byStatus.snoozed || 0} active={statusFilter === 'snoozed'} onClick={() => setStatusFilter('snoozed')} />
        <StatusChip label={t('inbox.status_all')} value={Object.values(byStatus).reduce((a, b) => a + b, 0)} active={statusFilter === ''} onClick={() => setStatusFilter('')} />
      </div>

      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 16 }}>
        <div className="card" style={{ padding: 0, maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={platformFilter}
              onChange={e => setPlatformFilter(e.target.value)}
              className="form-select"
              aria-label={t('inbox.filter_all_platforms')}
              style={{ padding: '4px 28px 4px 8px', width: 'auto' }}
            >
              <option value="">{t('inbox.filter_all_platforms')}</option>
              <option value="twitter">X (Twitter)</option>
              <option value="linkedin">LinkedIn</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('inbox.shown_count', { n: messages.length })}</span>
          </div>
          {loading ? (
            <div className="empty-state"><p>{t('inbox.loading')}</p></div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <p>{t('inbox.no_messages')}</p>
              <p style={{ fontSize: 12 }}>{t('inbox.connect_hint')}</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {messages.map(m => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(m)}
                    aria-pressed={selected?.id === m.id}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', font: 'inherit',
                      color: 'var(--text-primary)',
                      padding: '10px 14px',
                      border: 0,
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      background: selected?.id === m.id ? 'var(--bg-card-hover)' : 'transparent',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{m.author_handle || m.author_name || t('inbox.unknown_author')}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{m.platform}</span>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--text-primary)', marginBottom: 6 }}>
                      {truncate(m.text, 140)}
                    </div>
                    <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                      {m.sentiment && (
                        <span style={{ color: sentimentColor[m.sentiment] || 'var(--text-secondary)', fontWeight: 500 }}>
                          <span aria-hidden="true">● </span>{enumLabel(t, 'community', `sentiment_${m.sentiment}`)}
                        </span>
                      )}
                      {m.priority && m.priority !== 'normal' && (
                        <span style={{ color: priorityColor[m.priority], fontWeight: 500 }}>{enumLabel(t, 'community', `priority_${m.priority}`)}</span>
                      )}
                      <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                        {m.occurred_at ? new Date(m.occurred_at).toLocaleString() : ''}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card" style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
          {!selected ? (
            <div className="empty-state">
              <p>{t('inbox.select_hint')}</p>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                {selected.author_avatar_url && (
                  <img src={selected.author_avatar_url} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{selected.author_name || selected.author_handle || t('inbox.unknown_author')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {selected.author_handle} · {selected.platform} · {enumLabel(t, 'community', `kind_${selected.kind}`)}
                  </div>
                </div>
                {selected.url && (
                  <a href={selected.url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ padding: '4px 10px' }}>
                    {t('inbox.open_btn')}
                  </a>
                )}
              </div>

              <div style={{ background: 'var(--bg-card-hover)', padding: 12, borderRadius: 8, marginBottom: 16, whiteSpace: 'pre-wrap' }}>
                {selected.text}
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 12 }}>
                {selected.sentiment && (
                  <span className={`badge ${sentimentBadge[selected.sentiment] || 'badge-gray'}`}>
                    {t('inbox.badge_sentiment', { val: enumLabel(t, 'community', `sentiment_${selected.sentiment}`) })}
                  </span>
                )}
                {selected.priority && (
                  <span className={`badge ${priorityBadge[selected.priority] || 'badge-gray'}`}>
                    {t('inbox.badge_priority', { val: enumLabel(t, 'community', `priority_${selected.priority}`) })}
                  </span>
                )}
                {(selected.tags || []).map(tag => <span key={tag} className="badge badge-gray">{tag}</span>)}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label htmlFor="inbox-draft-reply" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{t('inbox.draft_label')}</label>
                  <button
                    onClick={() => handleDraft(selected)}
                    disabled={draftBusy}
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    {draftBusy ? t('inbox.btn_drafting') : selected.draft_reply ? t('inbox.btn_regenerate') : t('inbox.btn_generate')}
                  </button>
                </div>
                <textarea
                  id="inbox-draft-reply"
                  value={selected.draft_reply || ''}
                  onChange={e => handleDraftEdit(e.target.value)}
                  placeholder={t('inbox.draft_placeholder')}
                  rows={5}
                  className="form-textarea"
                  style={{ width: '100%', minHeight: 0, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" onClick={handleDraftSave}>{t('inbox.btn_save_draft')}</button>
                  {selected.status !== 'resolved' ? (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'resolved')}>
                      {t('inbox.btn_mark_resolved')}
                    </button>
                  ) : (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'open')}>
                      {t('inbox.btn_reopen')}
                    </button>
                  )}
                  {selected.status !== 'snoozed' && (
                    <button className="btn btn-secondary" onClick={() => handleStatusChange(selected, 'snoozed')}>
                      {t('inbox.btn_snooze')}
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  {t('inbox.footer_hint', { platform: selected.platform })}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showApifySync && (
        <Modal
          onClose={() => setShowApifySync(false)}
          labelledBy="inbox-apify-sync-title"
          overlayStyle={{ zIndex: 1500 }}
          style={{ maxWidth: 560 }}
        >
            <div className="modal-header">
              <h3 id="inbox-apify-sync-title">{t('inbox.apify_sync_title')}</h3>
              <button className="btn-icon" onClick={() => setShowApifySync(false)} aria-label={t('common.close')} title={t('common.close')}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                {t('inbox.apify_sync_subtitle')}
              </p>
              <FormField label={t('inbox.apify_sync_platform')} id="apify-platform">
                <select
                  className="form-select"
                  value={apifyPlatform}
                  onChange={e => setApifyPlatform(e.target.value)}
                >
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </select>
              </FormField>
              <FormField label={t('inbox.apify_sync_urls')} id="apify-urls" hint={t('inbox.apify_sync_hint')}>
                <textarea
                  className="form-textarea"
                  style={{ minHeight: 0 }}
                  rows={5}
                  placeholder={apifyPlatform === 'instagram'
                    ? 'https://www.instagram.com/p/ABCDE/\nhttps://www.instagram.com/reel/XYZ/'
                    : 'https://www.tiktok.com/@user/video/123\nhttps://www.tiktok.com/@user/video/456'}
                  value={apifyUrls}
                  onChange={e => setApifyUrls(e.target.value)}
                />
              </FormField>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowApifySync(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleApifySync} disabled={apifyBusy}>
                {apifyBusy ? t('common.loading') : t('inbox.apify_sync_submit')}
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}

function StatusChip({ label, value, active, onClick }) {
  return (
    <button
      type="button"
      className="stat-card"
      onClick={onClick}
      aria-pressed={active}
      style={{
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
        color: 'var(--text-primary)',
        width: '100%',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
        boxShadow: active ? '0 0 0 1px var(--accent)' : undefined,
      }}
    >
      <div className="stat-icon blue" aria-hidden="true">{String(value)}</div>
      <div><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>
    </button>
  );
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
