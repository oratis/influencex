import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import ErrorCard from '../components/ErrorCard';

// Swatches come from the `.platform-dot.<id>` rules in index.css — no colour
// literals here (design.md §0).
const PLATFORM_OPTIONS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'x', label: 'X (Twitter)' },
];

export default function CampaignList() {
  const { t } = useI18n();
  const [campaigns, setCampaigns] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const navigate = useNavigate();

  const loadCampaigns = async () => {
    try {
      const data = await api.getCampaigns();
      setCampaigns(data);
      setLoadError(null);
    } catch (e) {
      // Previously swallowed into console.error, so a failed fetch looked
      // exactly like "no campaigns yet".
      setLoadError(e);
    }
    setLoading(false);
  };

  useEffect(() => { loadCampaigns(); }, []);

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>{t('campaigns.title')}</h2>
          <p>{t('campaigns.subtitle')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {t('campaigns.new_campaign')}
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><p>{t('campaigns.loading')}</p></div>
      ) : loadError && campaigns.length === 0 ? (
        <ErrorCard error={loadError} onRetry={loadCampaigns} />
      ) : campaigns.length === 0 ? (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          <h4>{t('campaigns.no_campaigns')}</h4>
          <p>{t('campaigns.no_campaigns_hint')}</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>{t('campaigns.create_campaign')}</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '16px' }}>
          {campaigns.map(c => (
            <div
              key={c.id}
              className="card"
              style={{ cursor: 'pointer' }}
              role="button"
              tabIndex={0}
              aria-label={t('campaigns.open_campaign', { name: c.name })}
              onClick={() => navigate(`/campaigns/${c.id}`)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/campaigns/${c.id}`);
                }
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '4px' }}>{c.name}</h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>{c.description || t('campaigns.no_description')}</p>
                </div>
                <span className={`badge ${c.status === 'active' ? 'badge-green' : 'badge-gray'}`}>
                  {t(`campaigns.status_${c.status}`)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                {(c.platforms || []).map(p => (
                  <span key={p} className="platform-icon">
                    <span className={`platform-dot ${p}`} />
                    {p}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '16px', fontSize: '13px', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                <span>📊 {t('campaigns.kols_total', { count: c.kol_total || 0 })}</span>
                <span>✅ {t('campaigns.kols_approved', { count: c.kol_approved || 0 })}</span>
                <span>🎯 {t('campaigns.daily_target_hint', { count: c.daily_target })}</span>
                {c.budget > 0 && <span>💰 ${Number(c.budget).toLocaleString()}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateCampaignModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadCampaigns(); }} />
      )}
    </div>
  );
}

function CreateCampaignModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: '', description: '', platforms: [], daily_target: 10, budget: 0,
    filter_criteria: { min_followers: 10000, min_engagement: 1, categories: '' }
  });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const togglePlatform = (id) => {
    setForm(f => ({
      ...f,
      platforms: f.platforms.includes(id) ? f.platforms.filter(p => p !== id) : [...f.platforms, id]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api.createCampaign(form);
      onCreated();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} labelledBy="campaign-create-modal-title">
        <div className="modal-header">
          <h3 id="campaign-create-modal-title">{t('campaigns.create_modal_title')}</h3>
          <button className="btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <FormField label={t('campaigns.form_name')} required>
              <input className="form-input" placeholder={t('campaigns.form_name_placeholder')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </FormField>
            <FormField label={t('campaigns.form_description')}>
              <textarea className="form-textarea" placeholder={t('campaigns.form_description_placeholder')} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ minHeight: '80px' }} />
            </FormField>
            <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 18px' }}>
              <legend className="form-label">{t('campaigns.form_platforms')}</legend>
              <div className="platform-checks">
                {PLATFORM_OPTIONS.map(p => (
                  <label key={p.id} className={`platform-check ${form.platforms.includes(p.id) ? 'active' : ''}`}>
                    <input
                      type="checkbox"
                      checked={form.platforms.includes(p.id)}
                      onChange={() => togglePlatform(p.id)}
                      style={{ margin: 0 }}
                    />
                    <span className={`platform-dot ${p.id}`} aria-hidden="true" />
                    {p.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="form-row">
              <FormField label={t('campaigns.form_daily_target')}>
                <input type="number" className="form-input" value={form.daily_target} onChange={e => setForm(f => ({ ...f, daily_target: parseInt(e.target.value) || 10 }))} min="1" max="100" />
              </FormField>
              <FormField label={t('campaigns.form_budget')}>
                <input type="number" className="form-input" placeholder={t('campaigns.form_budget_placeholder')} value={form.budget || ''} onChange={e => setForm(f => ({ ...f, budget: parseFloat(e.target.value) || 0 }))} min="0" />
              </FormField>
            </div>
            <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px', marginTop: '8px' }}>{t('campaigns.filter_criteria')}</h4>
            <div className="form-row">
              <FormField label={t('campaigns.form_min_followers')}>
                <input type="number" className="form-input" value={form.filter_criteria.min_followers} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, min_followers: parseInt(e.target.value) || 0 } }))} />
              </FormField>
              <FormField label={t('campaigns.form_min_engagement')}>
                <input type="number" step="0.1" className="form-input" value={form.filter_criteria.min_engagement} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, min_engagement: parseFloat(e.target.value) || 0 } }))} />
              </FormField>
            </div>
            <FormField label={t('campaigns.form_categories')}>
              <input className="form-input" placeholder={t('campaigns.form_categories_placeholder')} value={form.filter_criteria.categories} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, categories: e.target.value } }))} />
            </FormField>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t('campaigns.creating') : t('campaigns.create_campaign')}</button>
          </div>
        </form>
    </Modal>
  );
}
