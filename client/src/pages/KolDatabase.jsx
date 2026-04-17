import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

const PLATFORM_COLORS = {
  tiktok: '#ff0050', youtube: '#ff0000', instagram: '#e1306c',
  twitch: '#9146ff', x: '#1da1f2', unknown: '#888',
};

export default function KolDatabase() {
  const { selectedCampaignId, selectedCampaign } = useCampaign();
  const [kols, setKols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [sort, setSort] = useState('');
  const [importing, setImporting] = useState(false);
  const [selectedKol, setSelectedKol] = useState(null);
  const [apiStatus, setApiStatus] = useState(null);
  const pollRef = useRef(null);
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();

  const loadKols = async () => {
    try {
      const params = {};
      if (search) params.search = search;
      if (platformFilter) params.platform = platformFilter;
      if (sort) params.sort = sort;
      const data = await api.getKolDatabase(params);
      setKols(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadKols(); api.getKolApiStatus().then(setApiStatus).catch(() => {}); }, [platformFilter, sort]);

  // Poll for scraping status updates
  useEffect(() => {
    const hasScraping = kols.some(k => k.scrape_status === 'scraping');
    if (hasScraping && !pollRef.current) {
      pollRef.current = setInterval(loadKols, 2000);
    } else if (!hasScraping && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [kols]);

  const handleSearch = (e) => {
    e.preventDefault();
    loadKols();
  };

  const handleImportCampaign = async () => {
    if (!selectedCampaignId) return;
    setImporting(true);
    try {
      const result = await api.importCampaignKols(selectedCampaignId);
      toast.success(`Imported ${result.imported} KOLs (${result.skipped} already existed)`);
      loadKols();
    } catch (e) { toast.error(e.message); }
    setImporting(false);
  };

  const handleDelete = async (id) => {
    const ok = await confirmDialog('Remove this KOL from the database?', { title: 'Delete KOL', danger: true, confirmText: 'Delete' });
    if (!ok) return;
    try {
      await api.deleteKolDatabaseEntry(id);
      toast.success('KOL removed');
      loadKols();
    } catch (e) { toast.error(e.message); }
  };

  const scrapingCount = kols.filter(k => k.scrape_status === 'scraping').length;

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>KOL Database</h2>
          <p>Global influencer database across all campaigns</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={async () => {
            try { await api.downloadCsv('/kol-database/export', 'kol-database.csv'); toast.success('Exported KOL database'); }
            catch (e) { toast.error(e.message); }
          }} disabled={kols.length === 0}>
            📤 Export CSV
          </button>
          {selectedCampaign && (
            <button className="btn btn-secondary" onClick={handleImportCampaign} disabled={importing}>
              {importing ? '⏳ Importing...' : `📥 Import from ${selectedCampaign.name}`}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            ➕ Add KOL by URL
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon purple">👥</div>
          <div><div className="stat-value">{kols.length}</div><div className="stat-label">Total KOLs</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">✅</div>
          <div><div className="stat-value">{kols.filter(k => k.scrape_status === 'complete').length}</div><div className="stat-label">Enriched</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon orange">⏳</div>
          <div><div className="stat-value">{scrapingCount}</div><div className="stat-label">Scraping</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">🏆</div>
          <div><div className="stat-value">{kols.filter(k => k.ai_score >= 80).length}</div><div className="stat-label">High Score (80+)</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red">📧</div>
          <div><div className="stat-value">{kols.filter(k => k.outreach_email_body).length}</div><div className="stat-label">Emails Ready</div></div>
        </div>
      </div>

      {/* API Status */}
      {apiStatus && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
            <span style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>Scraping APIs:</span>
            {[
              { key: 'youtube', label: 'YouTube', env: 'YOUTUBE_API_KEY' },
              { key: 'tiktok', label: 'TikTok', env: 'MODASH_API_KEY' },
              { key: 'instagram', label: 'Instagram', env: 'MODASH_API_KEY' },
              { key: 'twitch', label: 'Twitch', env: 'TWITCH_CLIENT_ID' },
            ].map(p => (
              <span key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: apiStatus[p.key] ? 'var(--success)' : 'var(--danger)' }} />
                <span style={{ color: apiStatus[p.key] ? 'var(--text-primary)' : 'var(--text-muted)' }}>{p.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ padding: '14px 16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', flex: 1, minWidth: '200px' }}>
            <input className="form-input" placeholder="Search KOLs..." value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1 }} />
            <button type="submit" className="btn btn-secondary btn-sm">Search</button>
          </form>
          <select className="form-select" value={platformFilter} onChange={e => setPlatformFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All Platforms</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
            <option value="instagram">Instagram</option>
            <option value="twitch">Twitch</option>
            <option value="x">X (Twitter)</option>
          </select>
          <select className="form-select" value={sort} onChange={e => setSort(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Newest First</option>
            <option value="followers">Most Followers</option>
            <option value="score">Highest Score</option>
            <option value="engagement">Best Engagement</option>
          </select>
        </div>
      </div>

      {scrapingCount > 0 && (
        <div className="card" style={{ marginBottom: '16px', padding: '10px 16px', borderLeft: '3px solid var(--warning)' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            ⏳ {scrapingCount} KOL{scrapingCount > 1 ? 's' : ''} being scraped and enriched by AI...
          </span>
        </div>
      )}

      {/* KOL Table */}
      {loading ? (
        <div className="empty-state"><p>Loading KOL database...</p></div>
      ) : kols.length === 0 ? (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, marginBottom: 12 }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <h4>No KOLs in Database</h4>
          <p>Add KOLs by entering their TikTok/YouTube profile URLs, or import from a campaign</p>
          <div className="btn-group" style={{ marginTop: '12px' }}>
            <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>➕ Add KOL by URL</button>
            {selectedCampaign && <button className="btn btn-secondary" onClick={handleImportCampaign}>📥 Import from Campaign</button>}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>KOL</th>
                  <th>Platform</th>
                  <th>Followers</th>
                  <th>Engagement</th>
                  <th>Avg Views</th>
                  <th>Category</th>
                  <th>AI Score</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {kols.map(kol => (
                  <tr key={kol.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedKol(kol)}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div className="kol-avatar">
                          <img src={kol.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${kol.username}`} alt="" />
                        </div>
                        <div>
                          <div style={{ fontWeight: '600', fontSize: '13px' }}>{kol.display_name || kol.username}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>@{kol.username}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="platform-icon"><span className={`platform-dot ${kol.platform}`} />{kol.platform}</span></td>
                    <td style={{ fontWeight: '600' }}>{formatNumber(kol.followers)}</td>
                    <td>{kol.engagement_rate ? kol.engagement_rate.toFixed(1) + '%' : '-'}</td>
                    <td>{formatNumber(kol.avg_views)}</td>
                    <td>{kol.category ? <span className="badge badge-blue">{kol.category}</span> : '-'}</td>
                    <td>
                      {kol.ai_score > 0 ? (
                        <span className={`badge ${kol.ai_score >= 80 ? 'badge-green' : kol.ai_score >= 60 ? 'badge-orange' : 'badge-red'}`}>
                          {kol.ai_score}
                        </span>
                      ) : '-'}
                    </td>
                    <td style={{ fontSize: '12px', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {kol.outreach_email_body ? <span className="badge badge-green">Ready</span> : '-'}
                    </td>
                    <td>
                      {kol.scrape_status === 'scraping' ? (
                        <span className="badge badge-orange">⏳ Scraping...</span>
                      ) : kol.scrape_status === 'error' ? (
                        <span className="badge badge-red" title={kol.scrape_error}>API Required</span>
                      ) : kol.scrape_status === 'partial' ? (
                        <span className="badge badge-orange" title="Partial data - some fields missing">Partial</span>
                      ) : (
                        <span className="badge badge-green">Complete</span>
                      )}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-sm btn-secondary" onClick={() => handleDelete(kol.id)} title="Remove">🗑️</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add KOL Modal */}
      {showAddModal && <AddKolModal onClose={() => setShowAddModal(false)} onAdded={loadKols} />}

      {/* KOL Detail Modal */}
      {selectedKol && <KolDetailModal kol={selectedKol} onClose={() => setSelectedKol(null)} />}
    </div>
  );
}

function AddKolModal({ onClose, onAdded }) {
  const [mode, setMode] = useState('single'); // single or batch
  const [url, setUrl] = useState('');
  const [batchUrls, setBatchUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmitSingle = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.addKolByUrl({ profile_url: url.trim() });
      setResult({ success: true, message: `Added @${res.username} (${res.platform}) - AI scraping in progress...` });
      setUrl('');
      onAdded();
    } catch (e) {
      setResult({ success: false, message: e.message });
    }
    setSubmitting(false);
  };

  const handleSubmitBatch = async (e) => {
    e.preventDefault();
    const urls = batchUrls.split('\n').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.batchAddKolUrls(urls);
      setResult({ success: true, message: `Queued ${res.queued} KOLs for scraping (${res.duplicates} duplicates skipped)` });
      setBatchUrls('');
      onAdded();
    } catch (e) {
      setResult({ success: false, message: e.message });
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <h3>Add KOL to Database</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="tabs" style={{ marginBottom: '16px' }}>
            <button className={`tab ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>Single URL</button>
            <button className={`tab ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>Batch Import</button>
          </div>

          {mode === 'single' ? (
            <form onSubmit={handleSubmitSingle}>
              <div className="form-group">
                <label className="form-label">Profile URL</label>
                <input
                  className="form-input"
                  placeholder="e.g., https://www.tiktok.com/@username or https://youtube.com/@channel"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  autoFocus
                />
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Supports TikTok, YouTube, Instagram, Twitch, and X (Twitter) profile URLs.
                  AI will automatically scrape profile data and generate an outreach email.
                </p>
              </div>
              <button type="submit" className="btn btn-primary" disabled={submitting || !url.trim()}>
                {submitting ? '⏳ Processing...' : '🤖 Add & Auto-Scrape'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmitBatch}>
              <div className="form-group">
                <label className="form-label">Profile URLs (one per line)</label>
                <textarea
                  className="form-textarea"
                  placeholder={`https://www.tiktok.com/@creator1\nhttps://youtube.com/@channel2\nhttps://instagram.com/influencer3`}
                  value={batchUrls}
                  onChange={e => setBatchUrls(e.target.value)}
                  style={{ minHeight: '200px', fontFamily: 'monospace', fontSize: '13px' }}
                  autoFocus
                />
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Paste multiple profile URLs. Each will be scraped and enriched by AI automatically.
                </p>
              </div>
              <button type="submit" className="btn btn-primary" disabled={submitting || !batchUrls.trim()}>
                {submitting ? '⏳ Processing...' : `🤖 Batch Add (${batchUrls.split('\n').filter(u => u.trim()).length} URLs)`}
              </button>
            </form>
          )}

          {result && (
            <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '6px', background: result.success ? 'var(--success-bg)' : 'var(--danger-bg)', fontSize: '13px' }}>
              <span style={{ color: result.success ? 'var(--success)' : 'var(--danger)' }}>{result.message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KolDetailModal({ kol, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="kol-avatar" style={{ width: 48, height: 48 }}>
              <img src={kol.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${kol.username}`} alt="" />
            </div>
            <div>
              <h3 style={{ marginBottom: '2px' }}>{kol.display_name || kol.username}</h3>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', gap: '10px' }}>
                <span className="platform-icon"><span className={`platform-dot ${kol.platform}`} />{kol.platform}</span>
                <span>@{kol.username}</span>
                {kol.country && <span>📍 {kol.country}</span>}
              </div>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Stats */}
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '20px' }}>
            <div className="stat-card"><div><div className="stat-value">{formatNumber(kol.followers)}</div><div className="stat-label">Followers</div></div></div>
            <div className="stat-card"><div><div className="stat-value">{kol.engagement_rate?.toFixed(1) || '0'}%</div><div className="stat-label">Engagement</div></div></div>
            <div className="stat-card"><div><div className="stat-value">{formatNumber(kol.avg_views)}</div><div className="stat-label">Avg Views</div></div></div>
            <div className="stat-card">
              <div>
                <div className="stat-value">
                  <span className={`badge ${kol.ai_score >= 80 ? 'badge-green' : kol.ai_score >= 60 ? 'badge-orange' : 'badge-red'}`} style={{ fontSize: '18px' }}>
                    {kol.ai_score || 0}
                  </span>
                </div>
                <div className="stat-label">AI Score</div>
              </div>
            </div>
          </div>

          {kol.ai_reason && (
            <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '6px', background: 'var(--accent-light)', fontSize: '13px' }}>
              <strong>AI Assessment:</strong> {kol.ai_reason}
            </div>
          )}

          {kol.bio && (
            <div style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>Bio</h4>
              <p style={{ fontSize: '14px', lineHeight: '1.5' }}>{kol.bio}</p>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px', fontSize: '13px' }}>
            <div><strong>Category:</strong> {kol.category || '-'}</div>
            <div><strong>CPM Estimate:</strong> {kol.estimated_cpm ? `$${kol.estimated_cpm}` : '-'}</div>
            <div><strong>Email:</strong> {kol.email || '-'}</div>
            <div><strong>Total Videos:</strong> {kol.total_videos || '-'}</div>
            <div><strong>Language:</strong> {kol.language || '-'}</div>
            <div><strong>Profile:</strong> <a href={kol.profile_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Open Profile</a></div>
          </div>

          {/* Generated Outreach Email */}
          {kol.outreach_email_subject && (
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '10px' }}>📧 AI-Generated Outreach Email</h4>
              <div className="card" style={{ padding: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: 'var(--accent)' }}>
                  Subject: {kol.outreach_email_subject}
                </div>
                <div className="email-preview" style={{ maxHeight: '300px', whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.6' }}>
                  {kol.outreach_email_body}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          {kol.profile_url && (
            <a href={kol.profile_url} target="_blank" rel="noreferrer" className="btn btn-primary">
              Open Profile
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
