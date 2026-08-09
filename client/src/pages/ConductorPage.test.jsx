import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * ConductorPage SSE handling (roadmap B3).
 *
 * The page consumes `GET /conductor/plans/:id/stream` for both plan building
 * and plan execution, and must fall back to polling when the stream is
 * unavailable. These tests drive a fake EventSource so the whole lifecycle —
 * subscribe, render, close, fall back — is exercised without a server.
 */

const h = vi.hoisted(() => {
  const instances = [];
  class FakeEventSource {
    constructor(planId) {
      this.planId = planId;
      this.listeners = {};
      this.closed = false;
      this.onerror = null;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() { this.closed = true; }
    /** Push a server event, in the wire shape the server writes. */
    emit(type, data = {}) {
      const payload = { data: JSON.stringify({ type, data, timestamp: '2026-08-09T00:00:00Z' }) };
      (this.listeners[type] || []).forEach(fn => fn(payload));
    }
    fail() { this.onerror?.({ type: 'error' }); }
  }
  return { instances, FakeEventSource };
});

vi.mock('../api/client', () => ({
  api: {
    listConductorPlans: vi.fn().mockResolvedValue({ plans: [] }),
    conductorPlanStart: vi.fn().mockResolvedValue({ planId: 'plan-1', status: 'building' }),
    conductorPlan: vi.fn(),
    conductorRun: vi.fn().mockResolvedValue({ success: true, planId: 'plan-1', steps: 2 }),
    getConductorPlan: vi.fn().mockResolvedValue({ id: 'plan-1', status: 'complete', plan: { steps: [] } }),
    streamConductorPlan: vi.fn((planId) => {
      const es = new h.FakeEventSource(planId);
      h.instances.push(es);
      return es;
    }),
  },
  toastApiError: (err) => err?.message || '',
  setApiTranslator: vi.fn(),
}));

const toastSpies = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('../components/Toast', () => ({ useToast: () => toastSpies }));

import { api } from '../api/client';
import { I18nProvider } from '../i18n';
import { CampaignContext } from '../CampaignContext';
import ConductorPage from './ConductorPage';

const PLAN = {
  steps: [
    { id: 's1', agent: 'research', input: { topic: 'x' }, stage: 'research' },
    { id: 's2', agent: 'content-text', input: { brief: 'y' }, stage: 'draft', dependsOn: ['s1'] },
  ],
  rationale: 'research then draft',
};

function renderPage() {
  return render(
    <I18nProvider>
      <CampaignContext.Provider value={{ campaigns: [], selectedCampaignId: '', selectedCampaign: null }}>
        <ConductorPage />
      </CampaignContext.Provider>
    </I18nProvider>
  );
}

/** Type a goal and press "Build plan"; resolves once the stream is open. */
async function startPlanning(user) {
  await user.type(screen.getByPlaceholderText(/Develop a content strategy/i), 'Launch the thing');
  await user.click(screen.getByRole('button', { name: /Build plan/i }));
  await waitFor(() => expect(api.conductorPlanStart).toHaveBeenCalledWith('Launch the thing'));
  await waitFor(() => expect(h.instances.length).toBeGreaterThan(0));
  return h.instances[h.instances.length - 1];
}

beforeEach(() => {
  h.instances.length = 0;
  vi.clearAllMocks();
  api.listConductorPlans.mockResolvedValue({ plans: [] });
  api.conductorPlanStart.mockResolvedValue({ planId: 'plan-1', status: 'building' });
  api.conductorRun.mockResolvedValue({ success: true, planId: 'plan-1', steps: 2 });
  api.getConductorPlan.mockResolvedValue({ id: 'plan-1', status: 'complete', plan: { steps: [] } });
  // jsdom has no EventSource; the page feature-detects it before streaming.
  window.EventSource = function () {};
});

afterEach(() => {
  delete window.EventSource;
});

describe('ConductorPage — plan building over SSE', () => {
  it('renders the real build phases the server reports', async () => {
    const user = userEvent.setup();
    renderPage();
    const es = await startPlanning(user);

    expect(api.streamConductorPlan).toHaveBeenCalledWith('plan-1');

    await act(async () => {
      es.emit('build_phase', { phase: 'collecting_agents', agentCount: 18 });
      es.emit('build_phase', { phase: 'calling_llm', provider: 'anthropic', model: 'claude-sonnet-4-5' });
    });

    expect(screen.getByText(/Collecting available agents \(18\)/)).toBeInTheDocument();
    expect(screen.getByText(/Asking anthropic · claude-sonnet-4-5/)).toBeInTheDocument();
    // The honesty disclaimer must ship with the phases.
    expect(screen.getByText(/single model call/i)).toBeInTheDocument();
  });

  it('adopts the plan on plan_built and closes the stream', async () => {
    const user = userEvent.setup();
    renderPage();
    const es = await startPlanning(user);

    await act(async () => {
      es.emit('plan_built', { planId: 'plan-1', plan: PLAN, estimate: { totalUsdCents: 240 } });
    });

    expect(await screen.findByText('Proposed plan')).toBeInTheDocument();
    expect(screen.getByText('research')).toBeInTheDocument();
    expect(screen.getByText('content-text')).toBeInTheDocument();
    expect(es.closed).toBe(true);
  });

  it('surfaces a build failure inline and as a toast — never silently', async () => {
    const user = userEvent.setup();
    renderPage();
    const es = await startPlanning(user);

    await act(async () => {
      es.emit('plan_error', { message: 'LLM provider refused the request' });
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('LLM provider refused the request');
    expect(toastSpies.error).toHaveBeenCalledWith('LLM provider refused the request');
    expect(es.closed).toBe(true);
  });

  it('closes the previous stream before opening a new one', async () => {
    const user = userEvent.setup();
    renderPage();
    const first = await startPlanning(user);
    await act(async () => {
      first.emit('plan_built', { planId: 'plan-1', plan: PLAN, estimate: { totalUsdCents: 10 } });
    });
    await screen.findByText('Proposed plan');

    await user.click(screen.getByRole('button', { name: /Approve & run/i }));
    await waitFor(() => expect(h.instances.length).toBe(2));
    expect(first.closed).toBe(true);
    expect(h.instances[1].closed).toBe(false);
  });

  it('closes the stream on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    const es = await startPlanning(user);
    unmount();
    expect(es.closed).toBe(true);
  });
});

describe('ConductorPage — execution over SSE', () => {
  async function planThenApprove(user) {
    renderPage();
    const buildEs = await startPlanning(user);
    await act(async () => {
      buildEs.emit('plan_built', { planId: 'plan-1', plan: PLAN, estimate: { totalUsdCents: 240 } });
    });
    await screen.findByText('Proposed plan');
    await user.click(screen.getByRole('button', { name: /Approve & run/i }));
    await waitFor(() => expect(api.conductorRun).toHaveBeenCalledWith('plan-1'));
    await waitFor(() => expect(h.instances.length).toBe(2));
    return h.instances[1];
  }

  it('shows per-step status with the agent name as events arrive', async () => {
    const user = userEvent.setup();
    const es = await planThenApprove(user);

    await act(async () => {
      es.emit('plan_started', { planId: 'plan-1', totalSteps: 2, steps: [
        { stepId: 's1', agent: 'research', stage: 'research' },
        { stepId: 's2', agent: 'content-text', stage: 'draft' },
      ] });
      es.emit('wave_started', { wave: 1, stepIds: ['s1'] });
      es.emit('step_started', { stepId: 's1', agent: 'research', stage: 'research' });
      es.emit('step_progress', { stepId: 's1', agent: 'research', message: 'Scanning 12 sources' });
    });

    expect(screen.getByText('Execution progress')).toBeInTheDocument();
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
    expect(screen.getByText('Step 1: research')).toBeInTheDocument();
    expect(screen.getByText('Scanning 12 sources')).toBeInTheDocument();
    expect(screen.getByText('0 / 2 steps finished')).toBeInTheDocument();

    await act(async () => {
      es.emit('step_complete', { stepId: 's1', agent: 'research', summary: 'Three themes found' });
    });
    expect(screen.getByText('Three themes found')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 steps finished')).toBeInTheDocument();
  });

  it('surfaces a failed step error text and a summary toast (no silent failures)', async () => {
    const user = userEvent.setup();
    const es = await planThenApprove(user);

    await act(async () => {
      es.emit('step_started', { stepId: 's1', agent: 'research' });
      es.emit('step_failed', { stepId: 's1', agent: 'research', error: 'Apify quota exhausted' });
      es.emit('step_skipped', { stepId: 's2', agent: 'content-text', reason: 'upstream failed' });
    });

    expect(screen.getByText(/Apify quota exhausted/)).toBeInTheDocument();
    expect(screen.getByText(/upstream failed/)).toBeInTheDocument();

    await act(async () => {
      es.emit('plan_complete', { status: 'error', completed: 0, failed: 1, skipped: 1, firstError: 'Apify quota exhausted' });
    });

    await waitFor(() => expect(toastSpies.error).toHaveBeenCalled());
    expect(toastSpies.error.mock.calls[0][0]).toMatch(/2 step\(s\) failed. First error: Apify quota exhausted/);
    expect(es.closed).toBe(true);
  });
});

describe('ConductorPage — fallbacks', () => {
  it('uses the blocking endpoint when the browser has no EventSource', async () => {
    delete window.EventSource;
    api.conductorPlan.mockResolvedValue({ planId: 'plan-1', plan: PLAN, estimate: { totalUsdCents: 5 } });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText(/Develop a content strategy/i), 'No SSE here');
    await user.click(screen.getByRole('button', { name: /Build plan/i }));

    await waitFor(() => expect(api.conductorPlan).toHaveBeenCalled());
    expect(api.conductorPlanStart).not.toHaveBeenCalled();
    expect(h.instances.length).toBe(0);
    expect(await screen.findByText('Proposed plan')).toBeInTheDocument();
  });

  // The poll runs on a 2s interval. Fake timers must be installed *before* the
  // interval is created (a real interval can't be advanced afterwards), and
  // removed again so the trailing RTL assertions run on real timers.
  async function withFakeTimers(trigger) {
    vi.useFakeTimers();
    try {
      await act(async () => { trigger(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    } finally {
      vi.useRealTimers();
    }
  }

  it('falls back to polling when the stream errors mid-build', async () => {
    const user = userEvent.setup();
    renderPage();
    const es = await startPlanning(user);

    api.getConductorPlan.mockResolvedValue({
      id: 'plan-1', status: 'pending_approval', plan: PLAN, estimate: { totalUsdCents: 99 },
    });
    await withFakeTimers(() => es.fail());

    expect(es.closed).toBe(true);
    expect(api.getConductorPlan).toHaveBeenCalledWith('plan-1');
    expect(await screen.findByText('Proposed plan')).toBeInTheDocument();
  });

  it('falls back to polling when the server says nothing is streaming the plan', async () => {
    const user = userEvent.setup();
    renderPage();
    const es = await startPlanning(user);

    api.getConductorPlan.mockResolvedValue({
      id: 'plan-1', status: 'pending_approval', plan: PLAN, estimate: { totalUsdCents: 12 },
    });
    // Replay path: the plan is running on another instance (or a restart).
    await withFakeTimers(() => es.emit('plan_state', { status: 'building', live: false }));

    expect(api.getConductorPlan).toHaveBeenCalledWith('plan-1');
    expect(await screen.findByText('Proposed plan')).toBeInTheDocument();
  });
});
