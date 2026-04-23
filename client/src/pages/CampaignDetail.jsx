import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

function ScoreBadge({ score }) {
  const color = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warning)' : 'var(--danger)';
  const bg = score >= 80 ? 'var(--success-bg)' : score >= 60 ? 'var(--warning-bg)' : 'var(--danger-bg)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: bg, border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', color }}>
        {score}
      </div>
    </div>
  );
}

export default function CampaignDetail() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [kols, setKols] = useState([]);
  const [filter, setFilter] = useState({ status: '', platform: '', search: '' });
  const [selected, setSelected] = useState(new Set());
  const [collecting, setCollecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('ai_score');
  const toast = useToast();

  const loadData = async () => {
    try {
      const [c, k] = await Promise.all([api.getCampaign(id), api.getKols(id, filter)]);
      setCampaign(c);
      setKols(k);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [id]);
  useEffect(() => {
    if (!loading) {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.platform) params.platform = filter.platform;
      if (filter.search) params.search = filter.search;
      api.getKols(id, params).then(setKols).catch(console.error);
    }
  }, [filter]);

  const handleCollect = async () => {
    setCollecting(true);
    try {
      const result = await api.collectKols(id);
      toast.success(t('campaigns.collected_msg', { count: result.collected }));
      loadData();
    } catch (e) { toast.error(e.message); }
    setCollecting(false);
  };

  const handleStatusChange = async (kolId, status) => {
    await api.updateKol(kolId, { status });
    setKols(kols.map(k => k.id === kolId ? { ...k, status } : k));
  };

  const handleBatchAction = async (status) => {
    if (selected.size === 0) return;
    await api.batchUpdateKols([...selected], status);
    setKols(kols.map(k => selected.has(k.id) ? { ...k, status } : k));
    setSelected(new Set());
  };

  const toggleSelect = (kid) => {
    const next = new Set(selected);
    next.has(kid) ? next.delete(kid) : next.add(kid);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === sortedKols.length) setSelected(new Set());
    else setSelected(new Set(sortedKols.map(k => k.id)));
  };

  if (loading) return <div className="page-container"><p>{t('campaigns.loading_detail')}</p></div>;
  if (!campaign) return <div className="page-container"><p>{t('campaigns.not_found')}</p></div>;

  const stats = {
    total: kols.length,
    pending: kols.filter(k => k.status === 'pending').length,
    approved: kols.filter(k => k.status === 'approved').length,
    rejected: kols.filter(k => k.status === 'rejected').length,
    avgScore: kols.length > 0 ? Math.round(kols.reduce((s, k) => s + (k.ai_score || 0), 0) / kols.length) : 0,
  };

  const sortedKols = [...kols].sort((a, b) => {
    if (sortBy === 'ai_score') return (b.ai_score || 0) - (a.ai_score || 0);
    if (sortBy === 'followers') return b.followers - a.followers;
    if (sortBy === 'engagement') return b.engagement_rate - a.engagement_rate;
    if (sortBy === 'cpm') return (a.estimated_cpm || 0) - (b.estimated_cpm || 0);
    return 0;
  });

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
            <button className="btn-icon" onClick={() => navigate('/campaigns')} title={t('campaigns.back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <h2>{campaign.name}</h2>
            <span className={`badge ${campaign.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{t(`campaigns.status_${campaign.status}`)}</span>
          </div>
          <p style={{ marginLeft: '42px' }}>
            {campaign.description || t('campaigns.no_description')}
            {campaign.budget > 0 && <span style={{ marginLeft: '16px', color: 'var(--accent)', fontWeight: '600' }}>{t('campaigns.budget_label', { amount: campaign.budget.toLocaleString() })}</span>}
          </p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={async () => {
            try { await api.downloadCsv(`/campaigns/${id}/kols/export`, `kols-${campaign?.name || 'campaign'}.csv`); toast.success(t('campaigns.export_success')); }
            catch (e) { toast.error(e.message); }
          }} disabled={kols.length === 0}>
            📤 {t('campaigns.export_csv')}
          </button>
          <button className="btn btn-primary" onClick={handleCollect} disabled={collecting}>
            {collecting ? `⏳ ${t('campaigns.ai_collecting')}` : `🤖 ${t('campaigns.ai_collect')}`}
          </button>
          <button className="btn btn-success" onClick={() => navigate('/contacts')}>
            📧 {t('campaigns.go_to_contact')}
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon purple">📊</div>
          <div><div className="stat-value">{stats.total}</div><div className="stat-label">{t('campaigns.stat_total')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">🤖</div>
          <div><div className="stat-value">{stats.avgScore}</div><div className="stat-label">{t('campaigns.stat_avg_score')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon orange">⏳</div>
          <div><div className="stat-value">{stats.pending}</div><div className="stat-label">{t('campaigns.stat_pending')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">✅</div>
          <div><div className="stat-value">{stats.approved}</div><div className="stat-label">{t('campaigns.stat_approved')}</div></div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <input className="form-input search-input" placeholder={t('campaigns.filter_search')} value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} />
          <select className="form-select" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
            <option value="">{t('campaigns.filter_status_all')}</option>
            <option value="pending">{t('campaigns.filter_status_pending')}</option>
            <option value="approved">{t('campaigns.filter_status_approved')}</option>
            <option value="rejected">{t('campaigns.filter_status_rejected')}</option>
          </select>
          <select className="form-select" value={filter.platform} onChange={e => setFilter(f => ({ ...f, platform: e.target.value }))}>
            <option value="">{t('campaigns.filter_platform_all')}</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
            <option value="instagram">Instagram</option>
            <option value="twitch">Twitch</option>
            <option value="x">X</option>
          </select>
          <select className="form-select" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ minWidth: '140px' }}>
            <option value="ai_score">{t('campaigns.sort_score')}</option>
            <option value="followers">{t('campaigns.sort_followers')}</option>
            <option value="engagement">{t('campaigns.sort_engagement')}</option>
            <option value="cpm">{t('campaigns.sort_cpm')}</option>
          </select>
          {selected.size > 0 && (
            <>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('campaigns.selected_count', { count: selected.size })}</span>
              <button className="btn btn-success btn-sm" onClick={() => handleBatchAction('approved')}>✅ {t('campaigns.btn_approve')}</button>
              <button className="btn btn-danger btn-sm" onClick={() => handleBatchAction('rejected')}>❌ {t('campaigns.btn_reject')}</button>
            </>
          )}
        </div>

        {sortedKols.length === 0 ? (
          <div className="empty-state">
            <h4>{t('campaigns.empty_kols')}</h4>
            <p>{t('campaigns.empty_kols_hint')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <div className={`checkbox ${selected.size === sortedKols.length ? 'checked' : ''}`} onClick={toggleAll} />
                  </th>
                  <th>{t('campaigns.col_ai_score')}</th>
                  <th>{t('campaigns.col_kol')}</th>
                  <th>{t('campaigns.col_platform')}</th>
                  <th>{t('campaigns.col_followers')}</th>
                  <th>{t('campaigns.col_engagement')}</th>
                  <th>{t('campaigns.col_avg_views')}</th>
                  <th>{t('campaigns.col_cpm')}</th>
                  <th>{t('campaigns.col_category')}</th>
                  <th>{t('campaigns.col_status')}</th>
                  <th>{t('campaigns.col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedKols.map(kol => (
                  <tr key={kol.id}>
                    <td>
                      <div className={`checkbox ${selected.has(kol.id) ? 'checked' : ''}`} onClick={() => toggleSelect(kol.id)} />
                    </td>
                    <td>
                      <ScoreBadge score={kol.ai_score || 0} />
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div className="kol-avatar"><img src={kol.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${kol.username}`} alt="" /></div>
                        <div>
                          <div className="kol-name">{kol.display_name || kol.username}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={kol.ai_reason}>
                            {kol.ai_reason || `@${kol.username}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td><span className="platform-icon"><span className={`platform-dot ${kol.platform}`} />{kol.platform}</span></td>
                    <td>{formatNumber(kol.followers)}</td>
                    <td><span style={{ color: kol.engagement_rate >= 5 ? 'var(--success)' : kol.engagement_rate >= 3 ? 'var(--warning)' : 'var(--text-secondary)' }}>{kol.engagement_rate}%</span></td>
                    <td>{formatNumber(kol.avg_views)}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>${kol.estimated_cpm || '-'}</td>
                    <td><span className="badge badge-blue">{kol.category}</span></td>
                    <td>
                      <span className={`badge ${kol.status === 'approved' ? 'badge-green' : kol.status === 'rejected' ? 'badge-red' : 'badge-orange'}`}>
                        {t(`campaigns.kol_status_${kol.status}`)}
                      </span>
                    </td>
                    <td>
                      <div className="btn-group">
                        {kol.status !== 'approved' && (
                          <button className="btn btn-sm btn-success" onClick={() => handleStatusChange(kol.id, 'approved')}>✓</button>
                        )}
                        {kol.status !== 'rejected' && (
                          <button className="btn btn-sm btn-danger" onClick={() => handleStatusChange(kol.id, 'rejected')}>✕</button>
                        )}
                      </div>
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

function formatNumber(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
