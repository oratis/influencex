import React, { useState, useEffect, useCallback } from 'react';
import { api, toastApiError } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useWorkspace } from '../WorkspaceContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';
import ErrorCard from '../components/ErrorCard';

// Fallback used when a workspace hasn't saved a preferred keyword list.
// Moved from a hardcoded state default to a named constant so it's easy to
// swap or localize later.
const DEFAULT_DISCOVERY_KEYWORDS = 'gaming AI roleplay, AI character game, AI NPC gaming, AI companion roleplay';

const STAGE_KEYS = ['scrape', 'write', 'review', 'send', 'monitor', 'done'];

function StageProgress({ currentStage, t }) {
  const idx = STAGE_KEYS.indexOf(currentStage);
  const isError = currentStage === 'error';
  const icons = { scrape: '🔍', write: '✍️', review: '👁️', send: '📤', monitor: '📡', done: '✅' };
  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      {STAGE_KEYS.map((key, i) => {
        const isActive = i === idx;
        const isDone = i < idx;
        const bg = isError && i === idx ? 'var(--danger)' : isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--bg-elevated)';
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div title={t(`pipeline.stage_${key}`)} style={{
              width: 28, height: 28, borderRadius: '50%', background: bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '12px', border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
              opacity: isDone || isActive ? 1 : 0.4, transition: 'all 0.3s',
            }}>
              {isDone ? '✓' : icons[key]}
            </div>
            {i < STAGE_KEYS.length - 1 && <div style={{ width: 20, height: 2, background: isDone ? 'var(--success)' : 'var(--border)' }} />}
          </div>
        );
      })}
    </div>
  );
}

export default function PipelinePage() {
  const { t } = useI18n();
  const { selectedCampaignId } = useCampaign();
  const { currentWorkspace, currentId: currentWorkspaceId, refresh: refreshWorkspaces } = useWorkspace();
  const toast = useToast();
  const { confirm, prompt } = useConfirm();
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState('pipeline');
  const [discoveryJobs, setDiscoveryJobs] = useState([]);
  const [discoveryKeywords, setDiscoveryKeywords] = useState(
    currentWorkspace?.settings?.default_discovery_keywords || DEFAULT_DISCOVERY_KEYWORDS
  );
  const [discoveryMinSubs, setDiscoveryMinSubs] = useState(
    currentWorkspace?.settings?.default_discovery_min_subs || 5000
  );
  const [selectedDiscovery, setSelectedDiscovery] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryPlatforms, setDiscoveryPlatforms] = useState(['youtube']);
  const [platformAvailability, setPlatformAvailability] = useState([]);
  const [threadData, setThreadData] = useState(null);
  const [outreachTasks, setOutreachTasks] = useState({ pending: [], recent: [] });
  const [emailQueueStats, setEmailQueueStats] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pollDelay, setPollDelay] = useState(5000);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.getPipelineJobs();
      setJobs(data);
      setLoadError(null);
      return true;
    } catch (e) {
      setLoadError(e);
      return false;
    }
  }, []);

  const loadDiscoveryJobs = useCallback(async () => {
    try {
      const data = await api.getDiscoveryJobs();
      setDiscoveryJobs(data);
      return true;
    } catch (e) {
      return false;
    }
  }, []);

  const loadOutreachTasks = useCallback(async () => {
    try {
      const [tasks, stats] = await Promise.all([
        api.getOutreachTasks(),
        api.getEmailQueueStats().catch(() => null),
      ]);
      setOutreachTasks(tasks || { pending: [], recent: [] });
      setEmailQueueStats(stats);
      return true;
    } catch (e) {
      return false;
    }
  }, []);

  // Refresh all three loaders; back off on any failure so we don't hammer
  // a broken backend. Reset delay on success.
  const refreshAll = useCallback(async () => {
    const results = await Promise.all([loadJobs(), loadDiscoveryJobs(), loadOutreachTasks()]);
    const allOk = results.every(Boolean);
    setPollDelay(d => allOk ? 5000 : Math.min(d * 2, 60000));
  }, [loadJobs, loadDiscoveryJobs, loadOutreachTasks]);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, pollDelay);
    return () => clearInterval(interval);
  }, [refreshAll, pollDelay]);

  // When the workspace loads, seed the discovery form with the workspace's
  // saved defaults — but only if the user hasn't already edited the fields
  // (tracked via ref). This avoids clobbering in-progress input when the
  // workspace context refreshes.
  const discoveryTouchedRef = React.useRef(false);
  useEffect(() => {
    if (discoveryTouchedRef.current) return;
    if (!currentWorkspace?.settings) return;
    const s = currentWorkspace.settings;
    if (s.default_discovery_keywords) setDiscoveryKeywords(s.default_discovery_keywords);
    if (s.default_discovery_min_subs) setDiscoveryMinSubs(s.default_discovery_min_subs);
  }, [currentWorkspace]);

  // Fetch platform availability once — tells us which checkboxes can be
  // enabled. Gracefully degrades to youtube-only if the call fails.
  useEffect(() => {
    api.getDiscoveryPlatforms()
      .then(d => setPlatformAvailability(d.platforms || []))
      .catch(() => setPlatformAvailability([
        { id: 'youtube', configured: true, requires: 'YOUTUBE_API_KEY' },
      ]));
  }, []);

  // Persist current discovery defaults to the workspace. Admin-only on the
  // server; non-admin callers get 403 which we surface as a toast.
  const saveDiscoveryDefaults = async () => {
    if (!currentWorkspaceId) return;
    try {
      await api.updateWorkspaceSettings(currentWorkspaceId, {
        default_discovery_keywords: discoveryKeywords,
        default_discovery_min_subs: discoveryMinSubs,
      });
      toast.success(t('common.success'));
      refreshWorkspaces?.();
    } catch (e) {
      toastApiError(e, toast, t);
    }
  };

  const handleRetryOutreach = async (contactId) => {
    try {
      await api.retryEmail(contactId);
      toast.success(t('pipeline.email_retry_queued'));
      loadOutreachTasks();
    } catch (e) { toast.error(e.message); }
  };

  const handleSyncStatus = async () => {
    try {
      await api.syncEmailStatus();
      toast.success(t('pipeline.email_sync_status_queued'));
      setTimeout(() => loadOutreachTasks(), 1500);
    } catch (e) { toast.error(e.message); }
  };

  const handleStartPipeline = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    try {
      await api.startPipeline({ profile_url: url.trim(), campaign_id: selectedCampaignId });
      setUrl('');
      loadJobs();
    } catch (e) { toast.error(e.message); }
    setSubmitting(false);
  };

  const handleApprove = async (job) => {
    let emailTo = job.email_to || job.kol_email;
    if (!emailTo) {
      emailTo = await prompt(t('pipeline.prompt_email'), { title: t('pipeline.prompt_email_title'), placeholder: t('pipeline.prompt_email_placeholder') });
    }
    if (!emailTo) return;
    setLoading(true);
    try {
      const result = await api.approvePipelineEmail(job.id, { email_to: emailTo });
      if (!result.success) toast.error(result.error || t('pipeline.failed_to_send'));
      loadJobs();
      setSelectedJob(null);
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  const handleReject = async (job) => {
    setLoading(true);
    try {
      await api.rejectPipelineEmail(job.id);
      loadJobs();
      setSelectedJob(null);
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  const handleStartDiscovery = async () => {
    if (discoveryPlatforms.length === 0) {
      toast.error(t('pipeline.discovery_no_platform') || 'Pick at least one platform');
      return;
    }
    setDiscovering(true);
    try {
      await api.startDiscovery({
        campaign_id: selectedCampaignId,
        keywords: discoveryKeywords,
        platforms: discoveryPlatforms,
        min_subscribers: discoveryMinSubs,
        max_results: 50,
      });
      loadDiscoveryJobs();
    } catch (e) { toast.error(e.message); }
    setDiscovering(false);
  };

  const togglePlatform = (id) => {
    setDiscoveryPlatforms(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const handleViewThread = async (job) => {
    try {
      const data = await api.getPipelineJobThread(job.id);
      setThreadData(data);
    } catch (e) { console.error(e); }
  };

  const handleViewDiscovery = async (job) => {
    try {
      const data = await api.getDiscoveryJob(job.id);
      setSelectedDiscovery(data);
    } catch (e) { toast.error(e.message); }
  };

  const handleProcessDiscovery = async (jobId) => {
    setLoading(true);
    try {
      const result = await api.processDiscoveryResults(jobId, { min_relevance: 30, max_process: 10 });
      toast.success(t('pipeline.discovery_process_msg', { count: result.processed }));
      loadJobs();
      loadDiscoveryJobs();
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  const activeJobs = jobs.filter(j => ['scrape', 'write'].includes(j.stage));
  const reviewJobs = jobs.filter(j => j.stage === 'review');
  const sentJobs = jobs.filter(j => ['send', 'monitor', 'done', 'replied'].includes(j.stage));
  const errorJobs = jobs.filter(j => j.stage === 'error');

  return (
    <div className="page-container fade-in">
      {loadError && jobs.length === 0 && (
        <ErrorCard error={loadError} onRetry={refreshAll} />
      )}
      <div className="page-header">
        <div>
          <h2>{t('pipeline.title')}</h2>
          <p>{t('pipeline.subtitle')}</p>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: '20px' }}>
        {[
          { key: 'pipeline', label: t('pipeline.tab_pipeline', { count: jobs.length }) },
          { key: 'email', label: t('pipeline.tab_email_tasks', { count: (outreachTasks.pending || []).length }) },
          { key: 'discovery', label: t('pipeline.tab_discovery', { count: discoveryJobs.length }) },
        ].map(tt => (
          <button key={tt.key} className={`tab ${tab === tt.key ? 'active' : ''}`} onClick={() => setTab(tt.key)}>
            {tt.label}
          </button>
        ))}
      </div>

      {tab === 'pipeline' && (
        <>
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '15px' }}>{t('pipeline.add_url_title')}</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                placeholder={t('pipeline.url_placeholder')}
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleStartPipeline()}
                style={{ flex: 1, padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '14px' }}
              />
              <button className="btn btn-primary" onClick={handleStartPipeline} disabled={submitting || !url.trim()}>
                {submitting ? t('pipeline.working') : `🚀 ${t('pipeline.start')}`}
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
              {t('pipeline.url_hint')}
            </p>
          </div>

          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '20px' }}>
            <div className="stat-card"><div><div className="stat-value">{activeJobs.length}</div><div className="stat-label">{t('pipeline.stat_processing')}</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--warning)' }}>{reviewJobs.length}</div><div className="stat-label">{t('pipeline.stat_awaiting')}</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--success)' }}>{sentJobs.length}</div><div className="stat-label">{t('pipeline.stat_sent')}</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--danger)' }}>{errorJobs.length}</div><div className="stat-label">{t('pipeline.stat_errors')}</div></div></div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>{t('pipeline.jobs_title')}</h3>
              <button className="btn btn-secondary" onClick={loadJobs}>🔄 {t('pipeline.refresh')}</button>
            </div>

            {jobs.length === 0 ? (
              <div className="empty-state">
                <h4>{t('pipeline.jobs_empty')}</h4>
                <p>{t('pipeline.jobs_empty_hint')}</p>
              </div>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>{t('pipeline.col_creator')}</th>
                      <th>{t('pipeline.col_platform')}</th>
                      <th>{t('pipeline.col_followers')}</th>
                      <th>{t('pipeline.col_category')}</th>
                      <th>{t('pipeline.col_stage')}</th>
                      <th>{t('pipeline.col_source')}</th>
                      <th>{t('pipeline.col_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map(job => (
                      <tr key={job.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {job.avatar_url && <img src={job.avatar_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />}
                            <div>
                              <div style={{ fontWeight: '500' }}>{job.display_name || job.username}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>@{job.username}</div>
                            </div>
                          </div>
                        </td>
                        <td><span className={`badge badge-${job.platform === 'youtube' ? 'red' : 'blue'}`}>{job.platform}</span></td>
                        <td>{job.followers ? formatNumber(job.followers) : '-'}</td>
                        <td style={{ fontSize: '12px' }}>{job.category || '-'}</td>
                        <td><StageProgress currentStage={job.stage} t={t} /></td>
                        <td><span className={`badge ${job.source === 'discovery' ? 'badge-purple' : 'badge-gray'}`}>{job.source}</span></td>
                        <td>
                          {job.stage === 'review' && (
                            <button className="btn btn-primary" onClick={() => setSelectedJob(job)} style={{ padding: '4px 12px', fontSize: '12px' }}>
                              {t('pipeline.review_email')}
                            </button>
                          )}
                          {job.stage === 'error' && (
                            <span style={{ fontSize: '12px', color: 'var(--danger)' }} title={job.error}>{(job.error || '').slice(0, 40)}</span>
                          )}
                          {['monitor', 'done', 'replied'].includes(job.stage) && (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <span className={`badge ${job.reply_detected ? 'badge-purple' : 'badge-green'}`}>
                                {job.reply_detected ? t('pipeline.replied_badge') : t('pipeline.sent_badge')}
                              </span>
                              <button className="btn btn-secondary btn-sm" onClick={() => handleViewThread(job)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                                {t('pipeline.thread_btn')}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'email' && (
        <EmailTasksPane
          tasks={outreachTasks}
          stats={emailQueueStats}
          onRetry={handleRetryOutreach}
          onSyncStatus={handleSyncStatus}
          t={t}
        />
      )}

      {tab === 'discovery' && (
        <>
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '15px' }}>{t('pipeline.discovery_title')}</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              {t('pipeline.discovery_hint')}
            </p>
            {platformAvailability.length > 0 && (
              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
                {platformAvailability.map(p => {
                  const enabled = p.configured;
                  const checked = discoveryPlatforms.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      title={enabled ? '' : `${t('pipeline.discovery_platform_unconfigured') || 'Requires'} ${p.requires}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 10px', borderRadius: 6,
                        border: `1px solid ${checked && enabled ? 'var(--accent)' : 'var(--border)'}`,
                        background: checked && enabled ? 'var(--accent-bg, rgba(59,130,246,0.08))' : 'transparent',
                        cursor: enabled ? 'pointer' : 'not-allowed',
                        opacity: enabled ? 1 : 0.5,
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!enabled}
                        onChange={() => togglePlatform(p.id)}
                      />
                      <span style={{ textTransform: 'capitalize', fontWeight: checked ? 600 : 400 }}>{p.id}</span>
                      {!enabled && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {p.requires}</span>}
                    </label>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '10px', alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pipeline.discovery_keywords')}</label>
                <input
                  type="text"
                  value={discoveryKeywords}
                  onChange={e => { discoveryTouchedRef.current = true; setDiscoveryKeywords(e.target.value); }}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pipeline.discovery_subs_min')}</label>
                <input
                  type="number"
                  value={discoveryMinSubs}
                  onChange={e => { discoveryTouchedRef.current = true; setDiscoveryMinSubs(parseInt(e.target.value) || 1000); }}
                  style={{ width: '120px', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
                />
              </div>
              <button className="btn btn-secondary" onClick={saveDiscoveryDefaults} title={t('pipeline.save_defaults_hint') || 'Save as workspace default'}>
                💾
              </button>
              <button className="btn btn-primary" onClick={handleStartDiscovery} disabled={discovering}>
                {discovering ? t('pipeline.working') : `🔍 ${t('pipeline.discovery_run')}`}
              </button>
            </div>
          </div>

          {discoveryJobs.map(job => (
            <div key={job.id} className="card" style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: '600' }}>{t('pipeline.discovery_run_label')}</span>
                  <span className={`badge ${job.status === 'complete' ? 'badge-green' : job.status === 'running' ? 'badge-orange' : 'badge-red'}`} style={{ marginLeft: '8px' }}>{job.status}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '12px' }}>
                    {t('pipeline.discovery_found', { n: job.total_found })} | {t('pipeline.discovery_processed', { n: job.total_processed })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-secondary" onClick={() => handleViewDiscovery(job)} style={{ padding: '4px 12px', fontSize: '12px' }}>{t('pipeline.discovery_view')}</button>
                  {job.status === 'complete' && job.total_found > 0 && (
                    <button className="btn btn-primary" onClick={() => handleProcessDiscovery(job.id)} disabled={loading} style={{ padding: '4px 12px', fontSize: '12px' }}>
                      {t('pipeline.discovery_process')}
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {t('pipeline.discovery_keywords_prefix', { keywords: job.search_criteria?.keywords || '-' })} | {new Date(job.created_at).toLocaleString()}
              </div>
              {job.status === 'error' && job.error_message && (
                <div style={{ fontSize: '12px', color: 'var(--danger, #ff6b6b)', marginTop: 6, padding: '6px 10px', background: 'rgba(255,107,107,0.08)', borderRadius: 6 }}>
                  <strong>{t('common.error')}:</strong> {job.error_message}
                </div>
              )}
            </div>
          ))}

          {selectedDiscovery && (
            <div className="card" style={{ marginTop: '16px' }}>
              <div className="card-header">
                <h3>{t('pipeline.discovery_results_title', { count: selectedDiscovery.results?.length || 0 })}</h3>
                <button className="btn btn-secondary" onClick={() => setSelectedDiscovery(null)} style={{ padding: '4px 12px', fontSize: '12px' }}>{t('pipeline.close')}</button>
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr><th>{t('pipeline.discovery_col_channel')}</th><th>{t('pipeline.discovery_col_subs')}</th><th>{t('pipeline.discovery_col_relevance')}</th><th>{t('pipeline.discovery_col_status')}</th></tr>
                  </thead>
                  <tbody>
                    {(selectedDiscovery.results || []).map(r => (
                      <tr key={r.id}>
                        <td>
                          <a href={r.channel_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontWeight: '500' }}>
                            {r.channel_name}
                          </a>
                        </td>
                        <td style={{ fontWeight: '600' }}>{formatNumber(r.subscribers)}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <div style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                              <div style={{ width: `${r.relevance_score}%`, height: '100%', background: r.relevance_score > 60 ? 'var(--success)' : r.relevance_score > 30 ? 'var(--warning)' : 'var(--danger)', borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: '12px' }}>{r.relevance_score}</span>
                          </div>
                        </td>
                        <td><span className={`badge ${r.status === 'queued' ? 'badge-orange' : r.status === 'found' ? 'badge-gray' : 'badge-green'}`}>{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {selectedJob && <EmailReviewModal job={selectedJob} onApprove={handleApprove} onReject={handleReject} onClose={() => setSelectedJob(null)} loading={loading} />}
      {threadData && <EmailThreadModal data={threadData} onClose={() => setThreadData(null)} />}
    </div>
  );
}

function EmailReviewModal({ job, onApprove, onReject, onClose, loading }) {
  const { t } = useI18n();
  const [subject, setSubject] = useState(job.email_subject || '');
  const [body, setBody] = useState(job.email_body || '');
  const [emailTo, setEmailTo] = useState(job.email_to || job.kol_email || '');

  const handleSaveAndApprove = async () => {
    try {
      await api.editPipelineEmail(job.id, { email_subject: subject, email_body: body, email_to: emailTo });
    } catch {}
    onApprove({ ...job, email_to: emailTo, email_subject: subject, email_body: body });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {job.avatar_url && <img src={job.avatar_url} alt="" style={{ width: 48, height: 48, borderRadius: '50%' }} />}
            <div>
              <h3 style={{ margin: 0 }}>{job.display_name || job.username}</h3>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                @{job.username} | {job.platform} | {t('pipeline.followers_suffix', { count: formatNumber(job.followers || 0) })}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '16px' }}>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>{t('pipeline.modal_engagement')}</div>
            <div style={{ fontWeight: '600' }}>{job.engagement_rate?.toFixed(1) || 0}%</div>
          </div>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>{t('pipeline.modal_avg_views')}</div>
            <div style={{ fontWeight: '600' }}>{formatNumber(job.avg_views || 0)}</div>
          </div>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>{t('pipeline.modal_category')}</div>
            <div style={{ fontWeight: '600' }}>{job.category || '-'}</div>
          </div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pipeline.modal_send_to')}</label>
          <input
            type="email"
            value={emailTo}
            onChange={e => setEmailTo(e.target.value)}
            placeholder={t('pipeline.prompt_email_placeholder')}
            style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pipeline.modal_subject')}</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pipeline.modal_body')}</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            style={{ width: '100%', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5' }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
          <button className="btn btn-secondary" onClick={() => onReject(job)} disabled={loading}>
            {t('pipeline.modal_regenerate')}
          </button>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-secondary" onClick={onClose}>{t('pipeline.modal_cancel')}</button>
            <button className="btn btn-primary" onClick={handleSaveAndApprove} disabled={loading || !emailTo}>
              {loading ? t('pipeline.modal_sending') : t('pipeline.modal_approve')}
            </button>
          </div>
        </div>

        {job.error && (
          <div style={{ marginTop: '12px', padding: '8px 12px', borderRadius: '6px', background: 'var(--danger-bg)', fontSize: '12px', color: 'var(--danger)' }}>
            {job.error}
          </div>
        )}
      </div>
    </div>
  );
}

function EmailThreadModal({ data, onClose }) {
  const { t } = useI18n();
  const { job, thread } = data;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0 }}>{t('pipeline.thread_title')}</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              {job?.display_name || job?.username} ({job?.email_to})
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>

        {(!thread || thread.length === 0) ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
            <p>{t('pipeline.thread_empty')}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {thread.map((msg, i) => (
              <div key={msg.id || i} style={{
                padding: '14px 16px',
                borderRadius: '10px',
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
                      {msg.direction === 'outbound' ? t('pipeline.thread_sent') : t('pipeline.thread_reply')}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {msg.from_email}
                    </span>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {msg.sent_at ? new Date(msg.sent_at).toLocaleString() : ''}
                  </span>
                </div>
                {msg.subject && (
                  <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-primary)' }}>
                    {msg.subject}
                  </div>
                )}
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
                  {msg.body_text}
                </div>
              </div>
            ))}
          </div>
        )}
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

function EmailTasksPane({ tasks, stats, onRetry, onSyncStatus, t }) {
  const pending = tasks.pending || [];
  const recent = tasks.recent || [];
  const scheduled = tasks.scheduled || [];

  return (
    <div>
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div><div className="stat-value">{stats?.pending || 0}</div>
          <div className="stat-label">{t('pipeline.email_stat_queued')}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-value" style={{ color: 'var(--accent)' }}>{stats?.running || 0}</div>
          <div className="stat-label">{t('pipeline.email_stat_running')}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-value" style={{ color: '#a29bfe' }}>{scheduled.length}</div>
          <div className="stat-label">{t('pipeline.email_stat_scheduled')}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-value" style={{ color: 'var(--warning)' }}>{stats?.retried || 0}</div>
          <div className="stat-label">{t('pipeline.email_stat_retried')}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-value" style={{ color: 'var(--danger)' }}>{stats?.failed || 0}</div>
          <div className="stat-label">{t('pipeline.email_stat_failed')}</div></div>
        </div>
      </div>

      {onSyncStatus && (
        <div style={{ marginBottom: 12, textAlign: 'right' }}>
          <button className="btn btn-secondary btn-sm" onClick={onSyncStatus}>
            🧹 {t('pipeline.email_sync_status')}
          </button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>{t('pipeline.email_needs_attention', { count: pending.length })}</h3>
        </div>
        {pending.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <p>{t('pipeline.email_no_issues')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('pipeline.col_creator')}</th>
                  <th>{t('pipeline.email_col_campaign')}</th>
                  <th>{t('pipeline.email_col_status')}</th>
                  <th>{t('pipeline.email_col_attempts')}</th>
                  <th>{t('pipeline.email_col_error')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pending.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {c.avatar_url && <img src={c.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
                        <div>
                          <div style={{ fontWeight: 500 }}>{c.display_name || c.username}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.kol_email}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12 }}>{c.campaign_name || '-'}</td>
                    <td>
                      <span className={`badge ${c.status === 'pending' ? 'badge-orange' : 'badge-red'}`}>
                        {t(`contacts.email_status_${c.status}`) || c.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{c.send_attempts || 0}</td>
                    <td style={{ fontSize: 11, color: 'var(--danger)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.send_error || c.bounce_reason}>
                      {c.send_error || c.bounce_reason || '-'}
                    </td>
                    <td>
                      {(c.status === 'failed' || c.status === 'bounced') && (
                        <button className="btn btn-secondary btn-sm" onClick={() => onRetry(c.id)}>
                          🔁 {t('pipeline.email_retry')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>{t('pipeline.email_scheduled', { count: scheduled.length })}</h3>
        </div>
        {scheduled.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <p>{t('pipeline.email_scheduled_empty')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('pipeline.col_creator')}</th>
                  <th>{t('pipeline.email_col_campaign')}</th>
                  <th>{t('pipeline.email_col_subject')}</th>
                  <th>{t('pipeline.email_col_scheduled_for')}</th>
                </tr>
              </thead>
              <tbody>
                {scheduled.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 500 }}>{c.display_name || c.username}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.kol_email}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{c.campaign_name || '-'}</td>
                    <td style={{ fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email_subject}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      🕒 {new Date(c.scheduled_send_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{t('pipeline.email_recent_sent', { count: recent.length })}</h3>
        </div>
        {recent.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <p>{t('pipeline.email_recent_empty')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('pipeline.col_creator')}</th>
                  <th>{t('pipeline.email_col_campaign')}</th>
                  <th>{t('pipeline.email_col_subject')}</th>
                  <th>{t('pipeline.email_col_status')}</th>
                  <th>{t('pipeline.email_col_when')}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 500 }}>{c.display_name || c.username}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.kol_email}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{c.campaign_name || '-'}</td>
                    <td style={{ fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email_subject}</td>
                    <td>
                      <span className={`badge ${c.status === 'opened' ? 'badge-purple' : c.status === 'delivered' ? 'badge-green' : 'badge-blue'}`}>
                        {t(`contacts.email_status_${c.status}`) || c.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {c.last_opened_at ? `👀 ${new Date(c.last_opened_at).toLocaleString()}` :
                       c.delivered_at ? `📬 ${new Date(c.delivered_at).toLocaleString()}` :
                       c.sent_at ? `📤 ${new Date(c.sent_at).toLocaleString()}` : '-'}
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
