import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api/client';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

// Platform-admin only. Lists recent Apify actor invocations from the
// apify_runs table — start time, duration, status, error. Useful for ops
// to spot stuck runs, quota exhaustion patterns, or actor-specific failures
// without dropping into the database.
export default function ApifyRunsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [reaping, setReaping] = useState(false);
  const [thresholdMin, setThresholdMin] = useState(null);

  const isPlatformAdmin = user?.role === 'admin';

  useEffect(() => { if (isPlatformAdmin) loadRuns(); }, [isPlatformAdmin, statusFilter]);

  async function loadRuns() {
    setLoading(true);
    try {
      const params = { limit: 100 };
      if (statusFilter) params.status = statusFilter;
      const r = await api.listApifyRuns(params);
      setRuns(r.runs || []);
      if (r.threshold_minutes) setThresholdMin(r.threshold_minutes);
    } catch (e) {
      toast.error(e.message);
    }
    setLoading(false);
  }

  async function handleReap() {
    setReaping(true);
    try {
      const r = await api.reapApifyRuns();
      toast.success(t('apify.reaped', { count: r.reaped || 0 }));
      loadRuns();
    } catch (e) { toast.error(e.message); }
    setReaping(false);
  }

  const summary = useMemo(() => {
    const out = { running: 0, succeeded: 0, failed: 0, timeout: 0, total: runs.length };
    for (const r of runs) {
      if (out[r.status] != null) out[r.status]++;
    }
    return out;
  }, [runs]);

  if (!isPlatformAdmin) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('apify.runs_title')}</h2></div>
        <div className="empty-state">
          <h4>{t('invite_codes.admin_required_title')}</h4>
          <p>{t('invite_codes.admin_required_hint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>{t('apify.runs_title')}</h2>
          <p>{t('apify.runs_subtitle')}{thresholdMin ? ` · ${t('apify.threshold_label', { min: thresholdMin })}` : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={loadRuns} disabled={loading}>
            {t('common.refresh')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleReap} disabled={reaping}>
            {reaping ? t('common.loading') : t('apify.reap_now')}
          </button>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon purple">∑</div>
          <div><div className="stat-value">{summary.total}</div><div className="stat-label">{t('apify.total_runs')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">▶</div>
          <div><div className="stat-value">{summary.running}</div><div className="stat-label">{t('apify.status_running')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">✓</div>
          <div><div className="stat-value">{summary.succeeded}</div><div className="stat-label">{t('apify.status_succeeded')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red">✗</div>
          <div><div className="stat-value">{summary.failed}</div><div className="stat-label">{t('apify.status_failed')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon orange">⏱</div>
          <div><div className="stat-value">{summary.timeout}</div><div className="stat-label">{t('apify.status_timeout')}</div></div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <label className="form-label" htmlFor="apify-status-filter" style={{ marginBottom: 0 }}>{t('apify.col_status')}:</label>
          <select
            id="apify-status-filter"
            className="form-input"
            style={{ width: 160 }}
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="">{t('apify.filter_all')}</option>
            <option value="running">{t('apify.status_running')}</option>
            <option value="succeeded">{t('apify.status_succeeded')}</option>
            <option value="failed">{t('apify.status_failed')}</option>
            <option value="timeout">{t('apify.status_timeout')}</option>
          </select>
        </div>

        {loading ? (
          <div className="empty-state"><p>{t('common.loading')}</p></div>
        ) : runs.length === 0 ? (
          <div className="empty-state"><p>{t('apify.no_runs')}</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('apify.col_actor')}</th>
                  <th>{t('apify.col_status')}</th>
                  <th>{t('apify.col_workspace')}</th>
                  <th>{t('apify.col_duration')}</th>
                  <th>{t('apify.col_started')}</th>
                  <th>{t('apify.col_error')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{r.actor_id}</td>
                    <td>
                      <span className={`badge ${
                        r.status === 'succeeded' ? 'badge-green'
                        : r.status === 'failed' ? 'badge-red'
                        : r.status === 'timeout' ? 'badge-orange'
                        : r.status === 'running' ? 'badge-blue'
                        : 'badge-gray'
                      }`}>
                        {t(`apify.status_${r.status}`) || r.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {r.workspace_id ? r.workspace_id.slice(0, 8) + '…' : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {r.started_at ? new Date(r.started_at).toLocaleString() : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--danger)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error_message || ''}>
                      {r.error_message || '—'}
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
