import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import { useCampaign } from '../CampaignContext';

const PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'reddit'];

// KOL discovery launcher. Lets the user pick platforms + keywords + min
// followers, kicks off a discovery job, then polls /api/discovery/jobs/:id
// every 4s until it reaches a terminal state. Results render in a table the
// user can scan and (eventually) bulk-import into the active campaign.
//
// Backend contract:
//   POST /api/discovery/start { campaign_id?, keywords, platforms[], min_subscribers, max_results }
//     → { id, status }
//   GET  /api/discovery/jobs/:id → { id, status, progress?, result_count, results: [...] }
export default function DiscoveryPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { selectedCampaignId, campaigns } = useCampaign();

  const [selectedPlatforms, setSelectedPlatforms] = useState(['youtube', 'instagram', 'tiktok']);
  const [keywords, setKeywords] = useState('');
  const [minSubscribers, setMinSubscribers] = useState(5000);
  const [maxResults, setMaxResults] = useState(50);

  const [job, setJob] = useState(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function togglePlatform(p) {
    setSelectedPlatforms(arr => arr.includes(p) ? arr.filter(x => x !== p) : [...arr, p]);
  }

  async function handleStart() {
    if (selectedPlatforms.length === 0) {
      toast.warning(t('discovery.no_platform_selected'));
      return;
    }
    if (!keywords.trim()) {
      toast.warning(t('discovery.keywords_required'));
      return;
    }
    setRunning(true);
    setResults([]);
    try {
      const r = await api.startDiscovery({
        campaign_id: selectedCampaignId || null,
        keywords: keywords.trim(),
        platforms: selectedPlatforms,
        min_subscribers: parseInt(minSubscribers, 10) || 1000,
        max_results: parseInt(maxResults, 10) || 50,
      });
      setJob(r);
      pollJob(r.id);
    } catch (e) {
      const msg = e.code === 'NO_CAMPAIGN' ? t('discovery.no_campaign') : e.message;
      toast.error(msg);
      setRunning(false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(prev => {
      if (prev.size === results.length) return new Set();
      return new Set(results.map(r => r.id).filter(Boolean));
    });
  }

  async function handleBulkAdd() {
    if (selectedIds.size === 0 || !job?.id) return;
    setImporting(true);
    try {
      const r = await api.processDiscoveryResults(job.id, { result_ids: Array.from(selectedIds) });
      toast.success(t('discovery.bulk_added', { count: r.processed || 0 }));
      setSelectedIds(new Set());
    } catch (e) {
      const msg = e.code === 'NO_CAMPAIGN' ? t('discovery.no_campaign') : e.message;
      toast.error(msg);
    }
    setImporting(false);
  }

  async function handleSaveToDb() {
    if (!job?.id) return;
    setImporting(true);
    try {
      const ids = selectedIds.size > 0 ? Array.from(selectedIds) : null;
      const r = await api.saveDiscoveryResultsToDb(job.id, ids ? { result_ids: ids } : {});
      toast.success(t('discovery.saved_to_db', { inserted: r.inserted, skipped: r.skipped }));
      setSelectedIds(new Set());
    } catch (e) {
      toast.error(e.message);
    }
    setImporting(false);
  }

  function handleExportCsv() {
    if (!job?.id) return;
    api.downloadCsv(`/discovery/jobs/${job.id}/export`, `discovery-${job.id.slice(0, 8)}.csv`)
      .catch(e => toast.error(e.message));
  }

  function pollJob(jobId) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.getDiscoveryJob(jobId);
        setJob(j);
        if (Array.isArray(j.results)) setResults(j.results);
        if (j.status === 'complete' || j.status === 'failed' || j.status === 'success') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRunning(false);
          if (j.status === 'failed') toast.error(t('discovery.job_failed', { error: j.error_message || 'unknown' }));
          else toast.success(t('discovery.job_succeeded'));
        }
      } catch (e) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunning(false);
        toast.error(e.message);
      }
    }, 4000);
  }

  const activeCampaign = campaigns.find(c => c.id === selectedCampaignId);

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <h2>{t('discovery.title')}</h2>
        <p>{t('discovery.subtitle')}</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>{t('discovery.launcher_title')}</h3>

        <div className="form-group">
          <label className="form-label">{t('discovery.platforms_label')}</label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {PLATFORMS.map(p => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: selectedPlatforms.includes(p) ? 'var(--accent-light)' : 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', border: `1px solid ${selectedPlatforms.includes(p) ? 'var(--accent)' : 'transparent'}` }}>
                <input
                  type="checkbox"
                  checked={selectedPlatforms.includes(p)}
                  onChange={() => togglePlatform(p)}
                />
                <span style={{ fontSize: 13 }}>{t(`discovery.platform_${p}`)}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="discovery-keywords">{t('discovery.keywords_label')}</label>
          <input
            id="discovery-keywords"
            className="form-input"
            type="text"
            placeholder={t('discovery.keywords_placeholder')}
            value={keywords}
            onChange={e => setKeywords(e.target.value)}
          />
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('discovery.keywords_hint')}</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="discovery-min">{t('discovery.min_subscribers')}</label>
            <input
              id="discovery-min"
              className="form-input"
              type="number"
              min="0"
              value={minSubscribers}
              onChange={e => setMinSubscribers(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="discovery-max">{t('discovery.max_results')}</label>
            <input
              id="discovery-max"
              className="form-input"
              type="number"
              min="1"
              max="500"
              value={maxResults}
              onChange={e => setMaxResults(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="btn btn-primary" onClick={handleStart} disabled={running}>
            {running ? t('discovery.starting') : t('discovery.start')}
          </button>
          {activeCampaign && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('discovery.target_campaign', { name: activeCampaign.name })}
            </span>
          )}
        </div>
      </div>

      {job && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>
              {t('discovery.job_title')}
              <span className={`badge ${job.status === 'complete' || job.status === 'success' ? 'badge-green' : job.status === 'failed' ? 'badge-red' : 'badge-blue'}`} style={{ marginLeft: 8 }}>
                {job.status}
              </span>
            </h3>
            {job.id && <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{job.id.slice(0, 8)}…</code>}
          </div>
          {job.error_message && (
            <p style={{ color: 'var(--danger)', fontSize: 13 }}>{job.error_message}</p>
          )}
          {results.length > 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('discovery.results_count', { count: results.length })}
            </p>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>{t('discovery.results_title')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {selectedIds.size > 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('discovery.selected_count', { count: selectedIds.size })}
                </span>
              )}
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleExportCsv}
                disabled={!job?.id}
                title={t('discovery.export_csv_title')}
              >
                {t('discovery.export_csv')}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleSaveToDb}
                disabled={importing || !job?.id}
                title={t('discovery.save_to_db_title')}
              >
                {t('discovery.save_to_db_btn')}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleBulkAdd}
                disabled={selectedIds.size === 0 || importing}
              >
                {importing ? t('common.loading') : t('discovery.bulk_add_btn')}
              </button>
            </div>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label={t('discovery.select_all')}
                      checked={results.length > 0 && selectedIds.size === results.filter(r => r.id).length}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>{t('discovery.col_username')}</th>
                  <th>{t('discovery.col_platform')}</th>
                  <th>{t('discovery.col_followers')}</th>
                  <th>{t('discovery.col_score')}</th>
                  <th>{t('discovery.col_email')}</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 200).map((r, i) => (
                  <tr key={r.id || `${r.platform}-${r.username}-${i}`}>
                    <td>
                      {r.id ? (
                        <input
                          type="checkbox"
                          aria-label={t('discovery.select_row')}
                          checked={selectedIds.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                        />
                      ) : null}
                    </td>
                    <td>
                      <a href={r.profile_url || r.channel_url || '#'} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                        {r.display_name || r.channel_name || r.username}
                      </a>
                    </td>
                    <td><span className="badge badge-gray">{r.platform}</span></td>
                    <td style={{ fontSize: 13 }}>
                      {Number(r.followers || r.subscribers || 0).toLocaleString()}
                    </td>
                    <td style={{ fontSize: 13 }}>{r.score != null ? r.score : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
