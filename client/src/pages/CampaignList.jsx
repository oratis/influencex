import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

const PLATFORM_OPTIONS = [
  { id: 'tiktok', label: 'TikTok', color: '#ff0050' },
  { id: 'youtube', label: 'YouTube', color: '#ff0000' },
  { id: 'instagram', label: 'Instagram', color: '#e1306c' },
  { id: 'twitch', label: 'Twitch', color: '#9146ff' },
  { id: 'x', label: 'X (Twitter)', color: '#1da1f2' },
];

export default function CampaignList() {
  const [campaigns, setCampaigns] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const loadCampaigns = async () => {
    try {
      const data = await api.getCampaigns();
      setCampaigns(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadCampaigns(); }, []);

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Campaigns</h2>
          <p>Create and manage KOL collection campaigns</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Campaign
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading campaigns...</p></div>
      ) : campaigns.length === 0 ? (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          <h4>No Campaigns Yet</h4>
          <p>Create your first campaign to start collecting KOL data</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create Campaign</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '16px' }}>
          {campaigns.map(c => (
            <div key={c.id} className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/campaigns/${c.id}`)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '4px' }}>{c.name}</h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>{c.description || 'No description'}</p>
                </div>
                <span className={`badge ${c.status === 'active' ? 'badge-green' : 'badge-gray'}`}>
                  {c.status}
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
                <span>📊 {c.kol_total || 0} KOLs</span>
                <span>✅ {c.kol_approved || 0} approved</span>
                <span>🎯 {c.daily_target}/day</span>
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
  const [form, setForm] = useState({
    name: '', description: '', platforms: [], daily_target: 10, budget: 0,
    filter_criteria: { min_followers: 10000, min_engagement: 1, categories: '' }
  });
  const [saving, setSaving] = useState(false);

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
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Create New Campaign</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Campaign Name *</label>
              <input className="form-input" placeholder="e.g., Hakko AI Q2 Push" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" placeholder="What's this campaign about?" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ minHeight: '80px' }} />
            </div>
            <div className="form-group">
              <label className="form-label">Target Platforms</label>
              <div className="platform-checks">
                {PLATFORM_OPTIONS.map(p => (
                  <label key={p.id} className={`platform-check ${form.platforms.includes(p.id) ? 'active' : ''}`} onClick={() => togglePlatform(p.id)}>
                    <span className={`platform-dot ${p.id}`} />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Daily Collection Target</label>
                <input type="number" className="form-input" value={form.daily_target} onChange={e => setForm(f => ({ ...f, daily_target: parseInt(e.target.value) || 10 }))} min="1" max="100" />
              </div>
              <div className="form-group">
                <label className="form-label">Campaign Budget ($)</label>
                <input type="number" className="form-input" placeholder="e.g., 10000" value={form.budget || ''} onChange={e => setForm(f => ({ ...f, budget: parseFloat(e.target.value) || 0 }))} min="0" />
              </div>
            </div>
            <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px', marginTop: '8px' }}>Filter Criteria</h4>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Min Followers</label>
                <input type="number" className="form-input" value={form.filter_criteria.min_followers} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, min_followers: parseInt(e.target.value) || 0 } }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Min Engagement Rate (%)</label>
                <input type="number" step="0.1" className="form-input" value={form.filter_criteria.min_engagement} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, min_engagement: parseFloat(e.target.value) || 0 } }))} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Content Categories (comma-separated)</label>
              <input className="form-input" placeholder="e.g., Gaming, Tech, Entertainment" value={form.filter_criteria.categories} onChange={e => setForm(f => ({ ...f, filter_criteria: { ...f.filter_criteria, categories: e.target.value } }))} />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating...' : 'Create Campaign'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
