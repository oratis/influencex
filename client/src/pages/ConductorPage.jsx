import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

/**
 * Conductor UI — describe a goal in natural language, Claude produces a
 * structured plan (DAG of agent invocations), you approve, we execute.
 */
export default function ConductorPage() {
  const [goal, setGoal] = useState('');
  const [currentPlan, setCurrentPlan] = useState(null); // { planId, plan, estimate }
  const [isPlanning, setIsPlanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [recentPlans, setRecentPlans] = useState([]);
  const [inspectedPlan, setInspectedPlan] = useState(null);
  const toast = useToast();

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
      toast.success('Plan approved. Executing in background.');
      // Poll until complete
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
          <h2>Conductor</h2>
          <p>Describe a goal. Claude builds a plan. You approve. Agents execute.</p>
        </div>
      </div>

      <div className="card">
        <label className="form-label">Your goal</label>
        <textarea
          className="form-textarea"
          placeholder="e.g. Develop a content strategy for our new AI agents feature, then draft a Twitter thread and a LinkedIn post to announce it. Target audience: technical SaaS founders."
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
            {isPlanning ? '🧠 Claude is thinking…' : '🧠 Build plan'}
          </button>
        </div>
      </div>

      {/* Proposed plan */}
      {currentPlan && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
          <div className="card-header">
            <h3>Proposed plan</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge badge-purple">{currentPlan.plan.steps?.length || 0} steps</span>
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
              <strong>Rationale:</strong> {currentPlan.plan.rationale}
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
                          depends on: {step.dependsOn.join(', ')}
                        </span>
                      )}
                    </div>
                    {step.humanApproval && <span className="badge badge-orange" style={{ fontSize: 10 }}>requires approval</span>}
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
              🚦 Approval gates: {currentPlan.plan.humanApprovalGates.join(' · ')}
            </div>
          )}
          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleApprove} disabled={isRunning}>
              {isRunning ? '⏳ Running…' : '✅ Approve & run'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setCurrentPlan(null); setGoal(''); }} disabled={isRunning}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Final execution result */}
      {inspectedPlan && inspectedPlan.plan?.stepResults && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>Execution result</h3>
            <span className={`badge ${inspectedPlan.status === 'complete' ? 'badge-green' : 'badge-red'}`}>
              {inspectedPlan.status}
            </span>
          </div>
          {inspectedPlan.plan.stepResults.map((r, i) => (
            <div key={i} style={{ marginBottom: 12, padding: 12, background: 'var(--bg-input)', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Step {i + 1}: {r.agent}</span>
                <span className={`badge ${r.status === 'complete' ? 'badge-green' : 'badge-red'}`}>{r.status}</span>
              </div>
              {r.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{r.error}</div>}
              {r.output && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>View output</summary>
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

      {/* Recent plans */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 14 }}>Recent plans ({recentPlans.length})</h3>
        {recentPlans.length === 0 ? (
          <div className="empty-state"><p>No plans yet. Describe a goal above.</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>Goal</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {recentPlans.map(p => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.goal}</td>
                    <td>
                      <span className={`badge ${
                        p.status === 'complete' ? 'badge-green' :
                        p.status === 'error' ? 'badge-red' :
                        p.status === 'running' ? 'badge-orange' : 'badge-gray'
                      }`}>{p.status}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(p.created_at).toLocaleString()}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={async () => {
                        try {
                          const full = await api.getConductorPlan(p.id);
                          setInspectedPlan(full);
                        } catch (e) { toast.error(e.message); }
                      }}>View</button>
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
