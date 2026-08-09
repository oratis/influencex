import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, toastApiError } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

/**
 * Conductor UI — describe a goal in natural language, Claude produces a
 * structured plan (DAG of agent invocations), you approve, we execute.
 *
 * Progress (roadmap B3): both long operations stream over SSE on the plan's
 * channel — `GET /conductor/plans/:id/stream`. Building reports the coarse
 * server-side phases it actually passes through (planning is one model call;
 * there is no finer real progress); execution reports per-step start /
 * progress / completion / failure with the agent name.
 *
 * Polling stays as the fallback for browsers without EventSource, for a
 * stream that errors, and for a plan whose work is running on another
 * instance (the server replays terminal state and closes rather than hanging).
 */
export default function ConductorPage() {
  const [goal, setGoal] = useState('');
  const [currentPlan, setCurrentPlan] = useState(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [recentPlans, setRecentPlans] = useState([]);
  const [inspectedPlan, setInspectedPlan] = useState(null);
  const [planElapsed, setPlanElapsed] = useState(0);
  const [planError, setPlanError] = useState('');
  // Live progress
  const [buildPhases, setBuildPhases] = useState([]);
  const [stepStates, setStepStates] = useState([]);
  const [wave, setWave] = useState(0);
  const [runError, setRunError] = useState('');
  const [usingFallback, setUsingFallback] = useState(false);

  const planAbortRef = useRef(null);
  const approvePollRef = useRef(null);
  // One EventSource at a time, ref-tracked so it is closed before reopening
  // and on unmount (PR #13 lifecycle discipline).
  const streamRef = useRef(null);
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

  const closeStream = useCallback(() => {
    if (streamRef.current) {
      try {
        // Drop onerror first: a close() can otherwise surface as an error and
        // kick off a fallback poll for work the user already cancelled.
        streamRef.current.onerror = null;
        streamRef.current.close();
      } catch { /* already closed */ }
      streamRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (approvePollRef.current) {
      clearInterval(approvePollRef.current);
      approvePollRef.current = null;
    }
  }, []);

  // Tear everything down on unmount so nothing keeps hitting the API (or
  // calling setState) after the user navigates away.
  useEffect(() => () => {
    stopPolling();
    closeStream();
    if (planAbortRef.current) planAbortRef.current.abort();
  }, [closeStream, stopPolling]);

  function supportsSse() {
    return typeof window !== 'undefined' && typeof window.EventSource === 'function';
  }

  /**
   * Open the plan's SSE channel. Always closes any previous stream first.
   * `events` maps SSE event name → handler receiving the event payload.
   */
  function openPlanStream(planId, { events, onStreamError }) {
    closeStream();
    let es;
    try {
      es = api.streamConductorPlan(planId);
    } catch {
      onStreamError?.();
      return null;
    }
    streamRef.current = es;
    for (const [type, handler] of Object.entries(events)) {
      es.addEventListener(type, (e) => {
        let payload = {};
        try { payload = (JSON.parse(e.data) || {}).data || {}; } catch { /* keep {} */ }
        handler(payload);
      });
    }
    es.onerror = () => { closeStream(); onStreamError?.(); };
    return es;
  }

  async function loadRecent() {
    try {
      const r = await api.listConductorPlans();
      setRecentPlans(r.plans || []);
    } catch (e) { /* ok */ }
  }

  function resetPlanUi() {
    setCurrentPlan(null);
    setInspectedPlan(null);
    setPlanElapsed(0);
    setPlanError('');
    setRunError('');
    setBuildPhases([]);
    setStepStates([]);
    setWave(0);
    setUsingFallback(false);
  }

  function adoptPlan({ planId, plan, cost, estimate }) {
    closeStream();
    setCurrentPlan({ planId, plan, cost, estimate });
    setIsPlanning(false);
    loadRecent();
  }

  function failPlan(message) {
    closeStream();
    const msg = message || t('common.error');
    setPlanError(msg);
    toast.error(msg);
    setIsPlanning(false);
    loadRecent();
  }

  async function handlePlan() {
    if (!goal.trim()) return;
    resetPlanUi();
    setIsPlanning(true);
    if (!supportsSse()) return handlePlanBlocking();

    let planId;
    try {
      const r = await api.conductorPlanStart(goal.trim());
      planId = r.planId;
    } catch (e) {
      // Toast + keep the message for the inline error card next to the
      // button so a failed POST is never silent.
      setPlanError(toastApiError(e, toast, t) || t('common.error'));
      setIsPlanning(false);
      return;
    }

    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      setUsingFallback(true);
      pollForBuiltPlan(planId);
    };
    openPlanStream(planId, {
      events: {
        build_phase: (d) => setBuildPhases(prev => [...prev, d]),
        plan_built: (d) => { settled = true; adoptPlan({ planId, plan: d.plan, cost: d.cost, estimate: d.estimate }); },
        plan_error: (d) => { settled = true; failPlan(d.message); },
        // Nothing is streaming this plan here (another instance / restart).
        plan_state: fallback,
        closed: () => { closeStream(); fallback(); },
      },
      onStreamError: fallback,
    });
  }

  // Pre-SSE path: one blocking POST that returns the finished plan. Kept for
  // browsers without EventSource and as the recovery path when the stream dies.
  async function handlePlanBlocking() {
    const controller = new AbortController();
    planAbortRef.current = controller;
    try {
      const r = await api.conductorPlan(goal.trim(), { signal: controller.signal });
      setCurrentPlan(r);
      loadRecent();
    } catch (e) {
      // AbortError surfaces when the user cancels; don't toast.
      if (e.name !== 'AbortError') {
        setPlanError(toastApiError(e, toast, t) || t('common.error'));
      }
    } finally {
      setIsPlanning(false);
      planAbortRef.current = null;
    }
  }

  // Fallback for the streaming build: poll the plan row until it leaves
  // 'building'. Same shape as the run poll below.
  function pollForBuiltPlan(planId) {
    stopPolling();
    let tries = 0;
    let failures = 0;
    approvePollRef.current = setInterval(async () => {
      tries++;
      try {
        const p = await api.getConductorPlan(planId);
        failures = 0;
        if (p.status === 'error') {
          stopPolling();
          failPlan(p.plan?.error || t('common.error'));
        } else if (p.status !== 'building') {
          stopPolling();
          adoptPlan({ planId, plan: p.plan, estimate: p.estimate });
        } else if (tries > 45) {
          stopPolling();
          failPlan(t('common.error'));
        }
      } catch (e) {
        failures++;
        if (failures >= 3 || tries > 45) {
          stopPolling();
          setIsPlanning(false);
          setPlanError(toastApiError(e, toast, t) || t('common.error'));
        }
      }
    }, 2000);
  }

  function handleCancelPlan() {
    if (planAbortRef.current) {
      planAbortRef.current.abort();
      planAbortRef.current = null;
    }
    closeStream();
    stopPolling();
    setIsPlanning(false);
  }

  // Drive a 1s elapsed-time counter while planning so the user sees progress.
  useEffect(() => {
    if (!isPlanning) return;
    const start = Date.now();
    const iv = setInterval(() => setPlanElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [isPlanning]);

  function patchStep(stepId, patch) {
    setStepStates(prev => {
      const i = prev.findIndex(s => s.stepId === stepId);
      if (i < 0) return [...prev, { stepId, status: 'pending', ...patch }];
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  async function finishRun(planId, summary) {
    closeStream();
    stopPolling();
    setIsRunning(false);
    if (summary && summary.status === 'error') {
      const failed = (summary.failed || 0) + (summary.skipped || 0);
      const msg = t('conductor.run_failed', {
        count: failed,
        message: summary.firstError || t('common.error'),
      });
      setRunError(msg);
      toast.error(msg);
    }
    try {
      const p = await api.getConductorPlan(planId);
      setInspectedPlan(p);
    } catch (e) { /* the live step list already shows what happened */ }
    loadRecent();
  }

  async function handleApprove() {
    if (!currentPlan?.planId) return;
    const planId = currentPlan.planId;
    setIsRunning(true);
    setRunError('');
    setUsingFallback(false);
    setWave(0);
    setStepStates((currentPlan.plan?.steps || []).map(s => ({
      stepId: s.id, agent: s.agent, stage: s.stage || null, status: 'pending',
    })));

    try {
      await api.conductorRun(planId);
      toast.success(t('conductor.executing_bg'));
    } catch (e) {
      toastApiError(e, toast, t);
      setIsRunning(false);
      return;
    }

    if (!supportsSse()) return startRunPolling(planId);

    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      setUsingFallback(true);
      startRunPolling(planId);
    };
    openPlanStream(planId, {
      events: {
        plan_started: (d) => {
          if (Array.isArray(d.steps) && d.steps.length) {
            setStepStates(d.steps.map(s => ({ ...s, status: 'pending' })));
          }
        },
        wave_started: (d) => setWave(d.wave || 0),
        step_started: (d) => patchStep(d.stepId, { status: 'running', agent: d.agent, stage: d.stage, error: null }),
        step_progress: (d) => patchStep(d.stepId, { message: d.message }),
        step_complete: (d) => patchStep(d.stepId, { status: 'complete', summary: d.summary, usdCents: d.usdCents, message: null }),
        step_failed: (d) => patchStep(d.stepId, { status: 'error', error: d.error, message: null }),
        step_skipped: (d) => patchStep(d.stepId, { status: 'skipped', error: d.reason, message: null }),
        plan_complete: (d) => { settled = true; finishRun(planId, d); },
        plan_state: fallback,
        closed: () => { closeStream(); fallback(); },
      },
      onStreamError: fallback,
    });
  }

  // Fallback for execution: the original 3s poll of /plans/:id.
  function startRunPolling(planId) {
    stopPolling();
    let tries = 0;
    let failures = 0;
    approvePollRef.current = setInterval(async () => {
      tries++;
      try {
        const p = await api.getConductorPlan(planId);
        failures = 0;
        if (p.status === 'complete' || p.status === 'error' || tries > 60) {
          stopPolling();
          setIsRunning(false);
          setInspectedPlan(p);
          const results = p.plan?.stepResults || [];
          if (p.status === 'error') {
            const bad = results.filter(r => r.status !== 'complete');
            const msg = t('conductor.run_failed', {
              count: bad.length,
              message: bad[0]?.error || t('common.error'),
            });
            setRunError(msg);
            toast.error(msg);
          }
          loadRecent();
        }
      } catch (e) {
        // Transient blips are fine; stop + surface after persistent failure
        // so the button doesn't stay in "Running…" forever.
        failures++;
        if (failures >= 3 || tries > 60) {
          stopPolling();
          setIsRunning(false);
          toastApiError(e, toast, t);
          loadRecent();
        }
      }
    }, 3000);
  }

  function formatMoney(cents) {
    if (cents == null) return '—';
    if (cents < 100) return `${cents}¢`;
    return `$${(cents / 100).toFixed(2)}`;
  }

  function phaseLabel(p) {
    switch (p.phase) {
      case 'collecting_agents': return t('conductor.phase_collecting_agents', { count: p.agentCount ?? 0 });
      case 'calling_llm': return t('conductor.phase_calling_llm', { provider: p.provider || '—', model: p.model || '—' });
      case 'parsing_plan': return t('conductor.phase_parsing_plan');
      case 'plan_ready': return t('conductor.phase_plan_ready', { count: p.steps ?? 0 });
      case 'saved': return t('conductor.phase_saved');
      default: return p.phase;
    }
  }

  const STATUS_BADGE = {
    pending: 'badge-gray',
    running: 'badge-orange',
    complete: 'badge-green',
    error: 'badge-red',
    skipped: 'badge-gray',
  };

  const doneCount = stepStates.filter(s => s.status === 'complete').length;

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
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={handlePlan}
            disabled={isPlanning || !goal.trim()}
          >
            {isPlanning ? `${t('conductor.thinking')} (${planElapsed}s)` : t('conductor.build_plan')}
          </button>
          {isPlanning && (
            <button className="btn btn-secondary" onClick={handleCancelPlan}>
              {t('common.cancel')}
            </button>
          )}
        </div>
        {planError && (
          <div role="alert" style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 13,
            background: 'var(--danger-bg, rgba(255,107,107,0.12))', color: 'var(--danger)',
            border: '1px solid var(--danger)',
          }}>
            {planError}
          </div>
        )}
      </div>

      {isPlanning && (buildPhases.length > 0 || usingFallback) && (
        <div className="card" style={{ marginTop: 16 }} aria-live="polite">
          <div className="card-header">
            <h3>{t('conductor.building_title')}</h3>
            {!usingFallback && <span className="badge badge-purple" style={{ fontSize: 11 }}>{t('conductor.live')}</span>}
          </div>
          {usingFallback && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              {t('conductor.polling_fallback')}
            </div>
          )}
          {buildPhases.length > 0 && (
            <>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {buildPhases.map((p, i) => (
                  <li key={`${p.phase}-${i}`} style={{
                    fontSize: 13,
                    color: i === buildPhases.length - 1 ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: i === buildPhases.length - 1 ? 600 : 400,
                  }}>
                    {phaseLabel(p)}
                  </li>
                ))}
              </ol>
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                {t('conductor.phase_note')}
              </div>
            </>
          )}
        </div>
      )}

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

      {stepStates.length > 0 && (
        <div className="card" style={{ marginTop: 16 }} aria-live="polite">
          <div className="card-header">
            <h3>{t('conductor.execution_progress')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {wave > 0 && <span className="badge badge-gray" style={{ fontSize: 11 }}>{t('conductor.wave_label', { n: wave })}</span>}
              <span className="badge badge-purple" style={{ fontSize: 11 }}>
                {t('conductor.steps_progress', { done: doneCount, total: stepStates.length })}
              </span>
            </div>
          </div>
          {usingFallback && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              {t('conductor.polling_fallback')}
            </div>
          )}
          {runError && (
            <div role="alert" style={{
              marginBottom: 10, padding: '8px 12px', borderRadius: 6, fontSize: 13,
              background: 'var(--danger-bg, rgba(255,107,107,0.12))', color: 'var(--danger)',
              border: '1px solid var(--danger)',
            }}>
              {runError}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stepStates.map((s, i) => (
              <div key={s.stepId || i} style={{
                padding: 10, background: 'var(--bg-input)', borderRadius: 8,
                border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {t('conductor.step_n', { n: i + 1, agent: s.agent })}
                  </span>
                  <span className={`badge ${STATUS_BADGE[s.status] || 'badge-gray'}`} style={{ fontSize: 10 }}>
                    {t(`conductor.status_${s.status}`)}
                  </span>
                </div>
                {s.message && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{s.message}</div>
                )}
                {s.summary && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{s.summary}</div>
                )}
                {s.error && (
                  <div role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
                    ✕ {s.error}
                  </div>
                )}
              </div>
            ))}
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
                        p.status === 'running' || p.status === 'building' ? 'badge-orange' : 'badge-gray'
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
