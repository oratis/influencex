import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';

const STAGES = [
  { key: 'scrape', label: 'Scrape', icon: '🔍', desc: 'AI scraping profile data' },
  { key: 'write', label: 'Write', icon: '✍️', desc: 'Generating outreach email' },
  { key: 'review', label: 'Review', icon: '👁️', desc: 'Waiting for your approval' },
  { key: 'send', label: 'Send', icon: '📤', desc: 'Sending email' },
  { key: 'monitor', label: 'Monitor', icon: '📡', desc: 'Monitoring for reply' },
  { key: 'done', label: 'Done', icon: '✅', desc: 'Complete' },
];

function StageProgress({ currentStage }) {
  const idx = STAGES.findIndex(s => s.key === currentStage);
  const isError = currentStage === 'error';
  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      {STAGES.map((s, i) => {
        const isActive = i === idx;
        const isDone = i < idx;
        const bg = isError && i === idx ? 'var(--danger)' : isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--bg-elevated)';
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div title={s.label} style={{
              width: 28, height: 28, borderRadius: '50%', background: bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '12px', border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
              opacity: isDone || isActive ? 1 : 0.4, transition: 'all 0.3s',
            }}>
              {isDone ? '✓' : s.icon}
            </div>
            {i < STAGES.length - 1 && <div style={{ width: 20, height: 2, background: isDone ? 'var(--success)' : 'var(--border)' }} />}
          </div>
        );
      })}
    </div>
  );
}

export default function PipelinePage() {
  const { selectedCampaignId } = useCampaign();
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState('pipeline');
  // Discovery state
  const [discoveryJobs, setDiscoveryJobs] = useState([]);
  const [discoveryKeywords, setDiscoveryKeywords] = useState('gaming AI roleplay, AI character game, AI NPC gaming, AI companion roleplay');
  const [discoveryMinSubs, setDiscoveryMinSubs] = useState(5000);
  const [selectedDiscovery, setSelectedDiscovery] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  // Email thread
  const [threadData, setThreadData] = useState(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.getPipelineJobs();
      setJobs(data);
    } catch (e) { console.error(e); }
  }, []);

  const loadDiscoveryJobs = useCallback(async () => {
    try {
      const data = await api.getDiscoveryJobs();
      setDiscoveryJobs(data);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    loadJobs();
    loadDiscoveryJobs();
    const interval = setInterval(() => {
      loadJobs();
      loadDiscoveryJobs();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadJobs, loadDiscoveryJobs]);

  const handleStartPipeline = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    try {
      await api.startPipeline({ profile_url: url.trim(), campaign_id: selectedCampaignId });
      setUrl('');
      loadJobs();
    } catch (e) { alert(e.message); }
    setSubmitting(false);
  };

  const handleApprove = async (job) => {
    const emailTo = job.email_to || job.kol_email || prompt('Enter KOL email address:');
    if (!emailTo) return;
    setLoading(true);
    try {
      const result = await api.approvePipelineEmail(job.id, { email_to: emailTo });
      if (!result.success) alert(result.error || 'Failed to send');
      loadJobs();
      setSelectedJob(null);
    } catch (e) { alert(e.message); }
    setLoading(false);
  };

  const handleReject = async (job) => {
    setLoading(true);
    try {
      await api.rejectPipelineEmail(job.id);
      loadJobs();
      setSelectedJob(null);
    } catch (e) { alert(e.message); }
    setLoading(false);
  };

  const handleStartDiscovery = async () => {
    setDiscovering(true);
    try {
      await api.startDiscovery({
        campaign_id: selectedCampaignId,
        keywords: discoveryKeywords,
        min_subscribers: discoveryMinSubs,
        max_results: 50,
      });
      loadDiscoveryJobs();
    } catch (e) { alert(e.message); }
    setDiscovering(false);
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
    } catch (e) { alert(e.message); }
  };

  const handleProcessDiscovery = async (jobId) => {
    setLoading(true);
    try {
      const result = await api.processDiscoveryResults(jobId, { min_relevance: 30, max_process: 10 });
      alert(`Processing ${result.processed} KOLs through pipeline`);
      loadJobs();
      loadDiscoveryJobs();
    } catch (e) { alert(e.message); }
    setLoading(false);
  };

  const activeJobs = jobs.filter(j => ['scrape', 'write'].includes(j.stage));
  const reviewJobs = jobs.filter(j => j.stage === 'review');
  const sentJobs = jobs.filter(j => ['send', 'monitor', 'done', 'replied'].includes(j.stage));
  const errorJobs = jobs.filter(j => j.stage === 'error');

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>AI Agent Pipeline</h2>
          <p>Input a creator URL to auto-scrape, generate outreach email, and send</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: '20px' }}>
        {[
          { key: 'pipeline', label: `Pipeline (${jobs.length})` },
          { key: 'discovery', label: `Discovery (${discoveryJobs.length})` },
        ].map(t => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pipeline' && (
        <>
          {/* URL Input */}
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '15px' }}>Add Creator URL</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                placeholder="https://www.youtube.com/@creator or https://www.tiktok.com/@creator"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleStartPipeline()}
                style={{ flex: 1, padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '14px' }}
              />
              <button className="btn btn-primary" onClick={handleStartPipeline} disabled={submitting || !url.trim()}>
                {submitting ? '...' : '🚀 Start Pipeline'}
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
              Supports YouTube and TikTok creator profile URLs. AI will auto-scrape profile, generate email, and wait for your approval.
            </p>
          </div>

          {/* Pipeline Stats */}
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '20px' }}>
            <div className="stat-card"><div><div className="stat-value">{activeJobs.length}</div><div className="stat-label">Processing</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--warning)' }}>{reviewJobs.length}</div><div className="stat-label">Awaiting Review</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--success)' }}>{sentJobs.length}</div><div className="stat-label">Sent / Monitoring</div></div></div>
            <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--danger)' }}>{errorJobs.length}</div><div className="stat-label">Errors</div></div></div>
          </div>

          {/* Jobs List */}
          <div className="card">
            <div className="card-header">
              <h3>Pipeline Jobs</h3>
              <button className="btn btn-secondary" onClick={loadJobs}>🔄 Refresh</button>
            </div>

            {jobs.length === 0 ? (
              <div className="empty-state">
                <h4>No pipeline jobs yet</h4>
                <p>Enter a creator URL above to start the AI agent pipeline</p>
              </div>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Creator</th>
                      <th>Platform</th>
                      <th>Followers</th>
                      <th>Category</th>
                      <th>Stage</th>
                      <th>Source</th>
                      <th>Actions</th>
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
                        <td><StageProgress currentStage={job.stage} /></td>
                        <td><span className={`badge ${job.source === 'discovery' ? 'badge-purple' : 'badge-gray'}`}>{job.source}</span></td>
                        <td>
                          {job.stage === 'review' && (
                            <button className="btn btn-primary" onClick={() => setSelectedJob(job)} style={{ padding: '4px 12px', fontSize: '12px' }}>
                              Review Email
                            </button>
                          )}
                          {job.stage === 'error' && (
                            <span style={{ fontSize: '12px', color: 'var(--danger)' }} title={job.error}>{(job.error || '').slice(0, 40)}</span>
                          )}
                          {['monitor', 'done', 'replied'].includes(job.stage) && (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <span className={`badge ${job.reply_detected ? 'badge-purple' : 'badge-green'}`}>
                                {job.reply_detected ? 'Replied' : 'Sent'}
                              </span>
                              <button className="btn btn-secondary btn-sm" onClick={() => handleViewThread(job)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                                Thread
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

      {/* Discovery Tab (Task 3) */}
      {tab === 'discovery' && (
        <>
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '15px' }}>KOL Discovery - HakkoAI Campaign</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              Automatically discover Gaming + AI Roleplay creators on YouTube using AI search
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Search Keywords</label>
                <input
                  type="text"
                  value={discoveryKeywords}
                  onChange={e => setDiscoveryKeywords(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Min Subscribers</label>
                <input
                  type="number"
                  value={discoveryMinSubs}
                  onChange={e => setDiscoveryMinSubs(parseInt(e.target.value) || 1000)}
                  style={{ width: '120px', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
                />
              </div>
              <button className="btn btn-primary" onClick={handleStartDiscovery} disabled={discovering}>
                {discovering ? '...' : '🔍 Start Discovery'}
              </button>
            </div>
          </div>

          {/* Discovery Jobs */}
          {discoveryJobs.map(job => (
            <div key={job.id} className="card" style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: '600' }}>Discovery Run</span>
                  <span className={`badge ${job.status === 'complete' ? 'badge-green' : job.status === 'running' ? 'badge-orange' : 'badge-red'}`} style={{ marginLeft: '8px' }}>{job.status}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '12px' }}>
                    Found: {job.total_found} | Processed: {job.total_processed}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-secondary" onClick={() => handleViewDiscovery(job)} style={{ padding: '4px 12px', fontSize: '12px' }}>View Results</button>
                  {job.status === 'complete' && job.total_found > 0 && (
                    <button className="btn btn-primary" onClick={() => handleProcessDiscovery(job.id)} disabled={loading} style={{ padding: '4px 12px', fontSize: '12px' }}>
                      Process Top 10
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Keywords: {job.search_criteria?.keywords || '-'} | {new Date(job.created_at).toLocaleString()}
              </div>
            </div>
          ))}

          {/* Discovery Results Modal */}
          {selectedDiscovery && (
            <div className="card" style={{ marginTop: '16px' }}>
              <div className="card-header">
                <h3>Discovery Results ({selectedDiscovery.results?.length || 0} channels)</h3>
                <button className="btn btn-secondary" onClick={() => setSelectedDiscovery(null)} style={{ padding: '4px 12px', fontSize: '12px' }}>Close</button>
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr><th>Channel</th><th>Subscribers</th><th>Relevance</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {(selectedDiscovery.results || []).map(r => (
                      <tr key={r.id}>
                        <td>
                          <a href={r.channel_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: '500' }}>
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

      {/* Email Review Modal */}
      {selectedJob && <EmailReviewModal job={selectedJob} onApprove={handleApprove} onReject={handleReject} onClose={() => setSelectedJob(null)} loading={loading} />}

      {/* Email Thread Modal */}
      {threadData && <EmailThreadModal data={threadData} onClose={() => setThreadData(null)} />}
    </div>
  );
}

function EmailReviewModal({ job, onApprove, onReject, onClose, loading }) {
  const [subject, setSubject] = useState(job.email_subject || '');
  const [body, setBody] = useState(job.email_body || '');
  const [emailTo, setEmailTo] = useState(job.email_to || job.kol_email || '');

  const handleSaveAndApprove = async () => {
    // Save edits first
    try {
      await api.editPipelineEmail(job.id, { email_subject: subject, email_body: body, email_to: emailTo });
    } catch {}
    onApprove({ ...job, email_to: emailTo, email_subject: subject, email_body: body });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {job.avatar_url && <img src={job.avatar_url} alt="" style={{ width: 48, height: 48, borderRadius: '50%' }} />}
            <div>
              <h3 style={{ margin: 0 }}>{job.display_name || job.username}</h3>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                @{job.username} | {job.platform} | {formatNumber(job.followers || 0)} followers
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>

        {/* KOL Info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '16px' }}>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>Engagement</div>
            <div style={{ fontWeight: '600' }}>{job.engagement_rate?.toFixed(1) || 0}%</div>
          </div>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>Avg Views</div>
            <div style={{ fontWeight: '600' }}>{formatNumber(job.avg_views || 0)}</div>
          </div>
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-elevated)', fontSize: '12px' }}>
            <div style={{ color: 'var(--text-muted)' }}>Category</div>
            <div style={{ fontWeight: '600' }}>{job.category || '-'}</div>
          </div>
        </div>

        {/* Email To */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Send To</label>
          <input
            type="email"
            value={emailTo}
            onChange={e => setEmailTo(e.target.value)}
            placeholder="creator@email.com"
            style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
          />
        </div>

        {/* Email Subject */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Subject</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px' }}
          />
        </div>

        {/* Email Body */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Email Body</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            style={{ width: '100%', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5' }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
          <button className="btn btn-secondary" onClick={() => onReject(job)} disabled={loading}>
            Regenerate Email
          </button>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveAndApprove} disabled={loading || !emailTo}>
              {loading ? 'Sending...' : 'Approve & Send'}
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
  const { job, thread } = data;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '700px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Email Thread</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              {job?.display_name || job?.username} ({job?.email_to})
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>

        {(!thread || thread.length === 0) ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
            <p>No emails in thread yet.</p>
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
                      {msg.direction === 'outbound' ? 'SENT' : 'REPLY'}
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
