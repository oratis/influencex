/**
 * Conductor plan progress streaming (roadmap B3).
 *
 * The Conductor's two long operations — building a plan (one blocking LLM
 * call) and executing it (N agent runs in dependency waves) — both used to be
 * invisible: the client got a spinner and a 3s poll. This module gives them a
 * single SSE channel, keyed by plan id.
 *
 * Shape mirrors `agent-runtime/index.js`'s `streamers` map: an in-process
 * Map<planId, EventEmitter> emitting `{ type, data, timestamp }`. It is
 * deliberately in-process — the same tradeoff the agent-run stream already
 * makes. On a multi-instance deploy a client can land on an instance that
 * isn't running the plan; that case is handled by the terminal-state replay
 * below (the stream closes with the DB state instead of hanging), and the
 * client falls back to polling.
 *
 * Event types on the plan channel:
 *   build_phase   { phase, ... }        coarse server-side phases of buildPlan
 *   plan_built    { planId, plan, ... } the plan is saved and awaiting approval
 *   plan_error    { message }           build failed
 *   plan_started  { totalSteps }        execution began
 *   wave_started  { wave, stepIds }     a dependency wave is about to run
 *   step_started  { stepId, agent, ... }
 *   step_progress { stepId, agent, message }
 *   step_complete { stepId, agent, summary, usdCents }
 *   step_failed   { stepId, agent, error }
 *   step_skipped  { stepId, agent, reason }
 *   plan_complete { status, completed, failed, skipped }
 *   plan_state    { status, live: false }   replay-only: nothing is running
 *   closed        {}                        always last
 */

const { EventEmitter } = require('events');

// How many events to keep per plan so a client that connects a beat late
// (the client can only open the stream after the POST returns) still sees
// everything that already happened.
const MAX_HISTORY = 300;

// SSE comment ping. Plan execution can idle for minutes inside one agent run;
// proxies (Cloud Run, Cloudflare) drop connections that go quiet.
const HEARTBEAT_MS = 25_000;

// Statuses that mean "nothing will ever be emitted for this plan again".
const TERMINAL_STATUSES = new Set(['complete', 'error']);

/** @type {Map<string, EventEmitter>} planId → emitter (with `.history`) */
const streams = new Map();

/**
 * Register (or fetch) the emitter for a plan. Call this *before* responding to
 * the POST that starts the work, so a client that connects immediately after
 * finds a live stream.
 */
function openPlanStream(planId) {
  const existing = streams.get(planId);
  if (existing) return existing;
  const emitter = new EventEmitter();
  // A plan can be watched from several tabs; Node's default max of 10 would
  // print a spurious leak warning.
  emitter.setMaxListeners(0);
  emitter.history = [];
  streams.set(planId, emitter);
  return emitter;
}

function getPlanStream(planId) {
  return streams.get(planId) || null;
}

/**
 * Emit one event on a plan's channel. No-op when nothing is streaming that
 * plan, so callers never need to guard.
 */
function emitPlanEvent(planId, type, data = {}) {
  const emitter = streams.get(planId);
  if (!emitter) return null;
  const evt = { type, data, timestamp: new Date().toISOString() };
  emitter.history.push(evt);
  if (emitter.history.length > MAX_HISTORY) emitter.history.shift();
  emitter.emit('event', evt);
  return evt;
}

/**
 * Emit the terminal `closed` event and retire the channel. Connections that
 * arrive afterwards take the DB replay path in the handler.
 */
function closePlanStream(planId) {
  const emitter = streams.get(planId);
  if (!emitter) return;
  emitPlanEvent(planId, 'closed', {});
  streams.delete(planId);
  emitter.removeAllListeners();
}

/** Test/shutdown helper — drop every channel. */
function resetPlanStreams() {
  for (const emitter of streams.values()) emitter.removeAllListeners();
  streams.clear();
}

/**
 * Condense an agent output into one line the UI can show next to a step.
 * Agent outputs are free-form objects; this picks the most human field it can
 * find rather than dumping JSON at the user.
 */
function summarizeOutput(output, maxLen = 180) {
  const truncate = (s) => (s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s);
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return truncate(output.trim());
  if (typeof output !== 'object') return truncate(String(output));
  if (Array.isArray(output)) return `${output.length} items`;

  for (const key of ['summary', 'text', 'content', 'headline', 'title', 'rationale', 'message']) {
    const v = output[key];
    if (typeof v === 'string' && v.trim()) return truncate(v.trim());
  }
  // Fall back to a shape description: "posts: 3, tone: friendly".
  const parts = [];
  for (const [k, v] of Object.entries(output).slice(0, 4)) {
    if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    else if (v && typeof v === 'object') parts.push(k);
    else if (typeof v === 'string') parts.push(`${k}: ${v.slice(0, 40)}`);
    else if (v !== undefined && v !== null) parts.push(`${k}: ${v}`);
  }
  return truncate(parts.join(', '));
}

/**
 * Bridge one agent run's private emitter onto the plan channel.
 *
 * The plan executor already attaches its own listener for persistence; this
 * adds a second, translation-only listener so the SSE channel carries
 * plan-level semantics (step ids, agent names) instead of raw agent events.
 *
 * @returns {() => void} detach function
 */
function bridgeStepEvents(planId, step, runId, agentStream) {
  const base = { stepId: step.id, agent: step.agent, stage: step.stage || null, runId };
  const listener = (evt) => {
    switch (evt && evt.type) {
      case 'started':
        emitPlanEvent(planId, 'step_started', { ...base });
        break;
      case 'progress': {
        const message = evt.data?.message || evt.data?.step || '';
        emitPlanEvent(planId, 'step_progress', { ...base, message: String(message).slice(0, 200) });
        break;
      }
      case 'complete':
        emitPlanEvent(planId, 'step_complete', {
          ...base,
          summary: summarizeOutput(evt.data?.output),
          usdCents: evt.data?.cost?.usdCents ?? null,
          durationMs: evt.data?.durationMs ?? null,
        });
        break;
      case 'error':
        emitPlanEvent(planId, 'step_failed', {
          ...base,
          error: String(evt.data?.message || 'unknown error').slice(0, 300),
        });
        break;
      default:
        break;
    }
  };
  agentStream.on('event', listener);
  return () => agentStream.off('event', listener);
}

/**
 * Rebuild what a finished (or orphaned) plan looked like, from the DB row.
 *
 * `conductor_plans.plan` carries `stepResults` — the executor's persisted
 * projection of each step's agent_runs row (runId, status, error, output).
 * Returning the same event shapes the live channel uses means the client has
 * exactly one rendering path.
 */
function replayFromPlanRow(planRow) {
  const events = [];
  const push = (type, data) => events.push({ type, data, timestamp: planRow.completed_at || new Date().toISOString(), replay: true });

  let planObj = {};
  try { planObj = JSON.parse(planRow.plan || '{}') || {}; } catch { planObj = {}; }

  const results = Array.isArray(planObj.stepResults) ? planObj.stepResults : [];
  let completed = 0, failed = 0, skipped = 0;
  for (const r of results) {
    const base = { stepId: r.id, agent: r.agent, stage: r.stage || null, runId: r.runId || null };
    if (r.status === 'complete') {
      completed++;
      push('step_complete', { ...base, summary: summarizeOutput(r.output), usdCents: null, durationMs: null });
    } else if (r.status === 'error') {
      failed++;
      push('step_failed', { ...base, error: String(r.error || 'unknown error').slice(0, 300) });
    } else {
      skipped++;
      push('step_skipped', { ...base, reason: String(r.error || 'skipped').slice(0, 300) });
    }
  }

  if (TERMINAL_STATUSES.has(planRow.status)) {
    push('plan_complete', { status: planRow.status, completed, failed, skipped, replay: true });
  } else {
    // 'building' / 'running' with no live channel means the work is happening
    // on another instance or died with a restart. Say so and close — a client
    // that hangs here is the bug this replaces.
    push('plan_state', { status: planRow.status, live: false });
  }
  return events;
}

/**
 * Build the `GET /api/conductor/plans/:id/stream` handler.
 *
 * Auth mirrors the agent-run stream exactly: session from the query-string
 * token (EventSource cannot set headers), then membership of the plan's OWN
 * workspace. A caller-supplied workspace is never consulted, and a non-member
 * gets 404 rather than 403 so plan existence doesn't leak.
 *
 * @param {object} deps { getSession, findMembership, queryOne, log }
 */
function createPlanStreamHandler({ getSession, findMembership, queryOne, log }) {
  return async function planStreamHandler(req, res) {
    try {
      const token = req.query?.token;
      const user = token ? await getSession(token) : null;
      if (!user) return res.status(401).end();

      const planId = req.params.id;
      const planRow = await queryOne(
        'SELECT id, workspace_id, status, plan, completed_at FROM conductor_plans WHERE id = ?',
        [planId]
      );
      if (!planRow) return res.status(404).end();
      const membership = await findMembership(planRow.workspace_id, user.id);
      if (!membership) return res.status(404).end(); // 404, not 403 — don't leak plan existence

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const write = (evt) => {
        try { res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`); } catch { /* client gone */ }
      };

      const stream = getPlanStream(planId);
      if (!stream) {
        for (const evt of replayFromPlanRow(planRow)) write(evt);
        write({ type: 'closed', data: {}, timestamp: new Date().toISOString(), replay: true });
        return res.end();
      }

      // Backfill: everything emitted before this client connected.
      for (const evt of stream.history) write(evt);

      const listener = (evt) => {
        write(evt);
        // Only `closed` ends the stream — a single failed step must not.
        if (evt.type === 'closed') setTimeout(() => { try { res.end(); } catch {} }, 50);
      };
      stream.on('event', listener);

      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* client gone */ }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      req.on('close', () => {
        clearInterval(heartbeat);
        stream.off('event', listener);
      });
    } catch (e) {
      log?.error?.('[conductor stream]', e.message);
      try { res.status(500).end(); } catch {}
    }
  };
}

module.exports = {
  openPlanStream,
  getPlanStream,
  emitPlanEvent,
  closePlanStream,
  resetPlanStreams,
  bridgeStepEvents,
  summarizeOutput,
  replayFromPlanRow,
  createPlanStreamHandler,
  HEARTBEAT_MS,
  MAX_HISTORY,
};
