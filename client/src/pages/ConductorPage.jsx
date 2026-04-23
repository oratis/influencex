import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

/**
 * Conductor UI — describe a goal in natural language, Claude produces a
 * structured plan (DAG of agent invocations), you approve, we execute.
 */
export default function ConductorPage() {
  const [goal, setGoal] = useState('');
  const [currentPlan, setCurrentPlan] = useState(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [recentPlans, setRecentPlans] = useState([]);
  const [inspectedPlan, setInspectedPlan] = useState(null);
  const toast = useToast();
  const { t } = useI18n();
  const { selectedCampaignId, campaigns } = useCampaign();
  const currentCampaign = campaigns?.find(c => c.id === selectedCampaignId);

  // Canned goal presets — mostly for users who don't know what to type.
  // The campaign name is threaded into the outreach preset so Conductor has
  // a concrete target instead of a placeholder.
  const presets = [
    {
      key: 'outreach_first_round',
      label: t('conductor.preset_outreach_first_round'),
      goal: currentCampaign
        ? t('conductor.preset_outreach_first_round_goal_with', { name: currentCampaign.name })
        : t('conductor.preset_outreach_first_round_goal'),
    },
    {
      key: 'weekly_digest',
      label: t('conductor.preset_weekly_digest'),
      goal: t('conductor.preset_weekly_digest_goal'),
    },
    {
      key: 'competitor_scan',
      label: t('conductor.preset_competitor_scan'),
      goal: t('conductor.preset_competitor_scan_goal'),
    },
  ];

  useEffect(() => { loadRecent(); }, []);

  async function loadRecent() {
    try {
      const r = await api.listConductorPlans();
      setRecentPlans(r.plans || []);
    } catch (e) { /* ok */ }
  }

  async function handlePlan() {
    if (!goal.trim()) return;
    setIsPlanning(true);
    setCurrentPlan(null);
    try {
      const r = await api.conductorPlan(goal.trim());
      setCurrentPlan(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setIsPlanning(false);
    }
  }

  async function handleApprove() {
    if (!currentPlan?.planId) return;
    setIsRunning(true);
    try {
      await api.conductorRun(currentPlan.planId);
      toast.success(t('conductor.executing_bg'));
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        const p = await api.getConductorPlan(currentPlan.planId);
        if (p.status === 'complete' || p.status === 'error' || tries > 60) {
          clearInterval(poll);
          setIsRunning(false);
          setInspectedPlan(p);
          loadRecent();
        }
      }, 3000);
    } catch (e) {
      toast.error(e.message);
      setIsRunning(false);
    }
  }

  function formatMoney(cents) {
    if (cents == null) return '—';
    if (cents < 100) return `${cents}¢`;
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('conductor.title')}</h2>
          <p>{t('conductor.subtitle')}</p>
        </div>
      </div>

      <div className="card">
        <label className="form-label">{t('conductor.goal')}</label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
            {t('conductor.presets_label')}:
          </span>
          {presets.map(p => (
            <button
              key={p.key}
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ fontSize: 11 }}
              onClick={() => setGoal(p.goal)}
              title={p.goal}
            >
              {p.label}
            </button>
          ))}
        </div>

        <textarea
          className="form-textarea"
          placeholder={t('conductor.goal_placeholder')}
          value={goal}
          onChange={e => setGoal(e.target.value)}
          style={{ minHeight: 100 }}
        />
        <div style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handlePlan}
            disabled={isPlanning || !goal.trim()}
          >
            {isPlanning ? t('conductor.thinking') : t('conductor.build_plan')}
          </button>
        </div>
      </div>

      {currentPlan && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
          <div className="card-header">
            <h3>{t('conductor.proposed_plan')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge badge-purple">{t('conductor.steps_count', { count: currentPlan.plan.steps?.length || 0 })}</span>
              <span className="badge badge-gray" style={{ fontSize: 11 }}>
                ~{formatMoney(currentPlan.estimate?.totalUsdCents || 0)}
              </span>
            </div>
          </div>
          {currentPlan.plan.rationale && (
            <div style={{
              padding: 12, background: 'var(--bg-input)', borderRadius: 8,
              fontSize: 13, lineHeight: 1.5, marginBottom: 14,
              borderLeft: '3px solid var(--accent)',
            }}>
              <strong>{t('conductor.rationale')}</strong> {currentPlan.plan.rationale}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
            {(currentPlan.plan.steps || []).map((step, i) => (
              <div key={step.id || i} style={{
                display: 'flex', gap: 12, padding: 12,
                background: 'var(--bg-input)', borderRadius: 8,
                border: '1px solid var(--border)',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--accent-light)', color: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 13, flexShrink: 0,
                }}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{step.agent}</span>
                      {step.dependsOn?.length > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                          {t('conductor.depends_on', { ids: step.dependsOn.join(', ') })}
                        </span>
                      )}
                    </div>
                    {step.humanApproval && <span className="badge badge-orange" style={{ fontSize: 10 }}>{t('conductor.requires_approval')}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <code style={{ fontSize: 11 }}>{JSON.stringify(step.input).slice(0, 160)}...</code>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {currentPlan.plan.humanApprovalGates?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 14 }}>
              {t('conductor.approval_gates', { gates: currentPlan.plan.humanApprovalGates.join(' · ') })}
            </div>
          )}
          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleApprove} disabled={isRunning}>
              {isRunning ? t('conductor.running') : t('conductor.approve_run')}
            </button>
            <button className="btn btn-secondary" onClick={() => { setCurrentPlan(null); setGoal(''); }} disabled={isRunning}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {inspectedPlan && inspectedPlan.plan?.stepResults && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>{t('conductor.execution_result')}</h3>
            <span className={`badge ${inspectedPlan.status === 'complete' ? 'badge-green' : 'badge-red'}`}>
              {t(`conductor.status_${inspectedPlan.status}`)}
            </span>
          </div>
          {inspectedPlan.plan.stepResults.map((r, i) => (
            <div key={i} style={{ marginBottom: 12, padding: 12, background: 'var(--bg-input)', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{t('conductor.step_n', { n: i + 1, agent: r.agent })}</span>
                <span className={`badge ${r.status === 'complete' ? 'badge-green' : 'badge-red'}`}>{t(`conductor.status_${r.status}`)}</span>
              </div>
              {r.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{r.error}</div>}
              {r.output && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>{t('conductor.view_output')}</summary>
                  <pre style={{
                    fontSize: 11, background: 'var(--bg-primary)', padding: 10,
                    borderRadius: 6, overflow: 'auto', maxHeight: 300,
                    margin: '6px 0 0',
                  }}>{JSON.stringify(r.output, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>{t('conductor.recent', { count: recentPlans.length })}</h3>
        {recentPlans.length === 0 ? (
          <div className="empty-state"><p>{t('conductor.no_plans')}</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>{t('conductor.col_goal')}</th><th>{t('conductor.col_status')}</th><th>{t('conductor.col_created')}</th><th></th></tr></thead>
              <tbody>
                {recentPlans.map(p => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.goal}</td>
                    <td>
                      <span className={`badge ${
                        p.status === 'complete' ? 'badge-green' :
                        p.status === 'error' ? 'badge-red' :
                        p.status === 'running' ? 'badge-orange' : 'badge-gray'
                      }`}>{t(`conductor.status_${p.status}`)}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(p.created_at).toLocaleString()}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={async () => {
                        try {
                          const full = await api.getConductorPlan(p.id);
                          setInspectedPlan(full);
                        } catch (e) { toast.error(e.message); }
                      }}>{t('conductor.view')}</button>
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
