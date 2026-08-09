/**
 * Conductor plan SSE (roadmap B3).
 *
 * Covers the three things that can silently break:
 *   1. Authorization — the stream resolves the workspace from the plan row and
 *      checks membership. A caller-supplied workspace must never be consulted,
 *      and a non-member must not learn whether the plan exists.
 *   2. Reconnect — connecting to a plan with no live channel must replay the
 *      DB state and close, never hang.
 *   3. Bridging — a plan run must surface per-step events, in order.
 *
 * server/index.js is not importable (it calls app.listen() at load — see the
 * note in pipeline-send-integration.test.js), so the handler is built from
 * server/conductor-stream.js with injected deps, which is exactly how
 * index.js builds it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const cs = require('../conductor-stream');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fakes

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    chunks: [],
    ended: false,
    flushed: false,
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k] = v; },
    flushHeaders() { res.flushed = true; },
    write(s) { res.chunks.push(s); return true; },
    end() { res.ended = true; return res; },
  };
  return res;
}

function fakeReq({ params = {}, query = {} } = {}) {
  const handlers = {};
  return {
    params,
    query,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    fire(ev) { (handlers[ev] || []).forEach(fn => fn()); },
  };
}

/** Parse the SSE frames a fake response collected. */
function framesOf(res) {
  return res.chunks
    .join('')
    .split('\n\n')
    .filter(f => f.startsWith('event:'))
    .map(f => {
      const type = f.match(/^event: (.+)$/m)[1];
      const data = JSON.parse(f.match(/^data: (.+)$/m)[1]);
      return { type, payload: data.data, raw: data };
    });
}

const PLAN_ID = 'plan-1';
const WS_OWN = 'ws-owner';

function makeHandler({ user = { id: 'u1' }, planRow, member = true, calls = {} } = {}) {
  calls.membership = [];
  calls.queryOne = [];
  return cs.createPlanStreamHandler({
    getSession: async (token) => (token === 'good-token' ? user : null),
    queryOne: async (sql, params) => { calls.queryOne.push({ sql, params }); return planRow ?? null; },
    findMembership: async (workspaceId, userId) => {
      calls.membership.push({ workspaceId, userId });
      return member ? { role: 'admin' } : null;
    },
    log: { error: () => {} },
  });
}

const finishedPlanRow = {
  id: PLAN_ID,
  workspace_id: WS_OWN,
  status: 'complete',
  completed_at: '2026-08-09T00:00:00.000Z',
  plan: JSON.stringify({
    steps: [{ id: 's1', agent: 'research' }, { id: 's2', agent: 'content-text' }],
    stepResults: [
      { id: 's1', agent: 'research', stage: 'research', runId: 'r1', status: 'complete', output: { summary: 'Found 3 competitors' } },
      { id: 's2', agent: 'content-text', stage: 'draft', runId: 'r2', status: 'error', error: 'rate limited' },
    ],
  }),
};

// ---------------------------------------------------------------------------
// 1. Authorization

test('stream: no token → 401, no SSE headers, nothing leaked', async () => {
  const res = fakeRes();
  const handler = makeHandler({ planRow: finishedPlanRow });
  await handler(fakeReq({ params: { id: PLAN_ID } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.ended, true);
  assert.equal(res.headers['Content-Type'], undefined);
  assert.equal(res.chunks.length, 0);
});

test('stream: bad token → 401', async () => {
  const res = fakeRes();
  const handler = makeHandler({ planRow: finishedPlanRow });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'nope' } }), res);
  assert.equal(res.statusCode, 401);
});

test('stream: unknown plan → 404', async () => {
  const res = fakeRes();
  const handler = makeHandler({ planRow: null });
  await handler(fakeReq({ params: { id: 'missing' }, query: { token: 'good-token' } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.chunks.length, 0);
});

test('stream: non-member → 404 (not 403), and membership is checked against the plan\'s own workspace', async () => {
  const calls = {};
  const res = fakeRes();
  const handler = makeHandler({ planRow: finishedPlanRow, member: false, calls });
  // A caller-supplied workspace must be ignored entirely.
  await handler(fakeReq({
    params: { id: PLAN_ID },
    query: { token: 'good-token', workspace_id: 'attacker-workspace' },
  }), res);

  assert.equal(res.statusCode, 404, 'must be 404 so plan existence does not leak');
  assert.equal(res.chunks.length, 0, 'no plan data may be written before authorization');
  assert.deepEqual(calls.membership, [{ workspaceId: WS_OWN, userId: 'u1' }]);
  // The lookup is by plan id alone — the workspace comes back from the row.
  assert.deepEqual(calls.queryOne[0].params, [PLAN_ID]);
});

test('stream: member gets SSE headers', async () => {
  const res = fakeRes();
  const handler = makeHandler({ planRow: finishedPlanRow });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['Cache-Control'], 'no-cache');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.equal(res.flushed, true);
});

// ---------------------------------------------------------------------------
// 2. Reconnect / replay

test('replay: finished plan with no live channel replays step results then closes', async () => {
  cs.resetPlanStreams();
  const res = fakeRes();
  const handler = makeHandler({ planRow: finishedPlanRow });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);

  const frames = framesOf(res);
  assert.deepEqual(frames.map(f => f.type), ['step_complete', 'step_failed', 'plan_complete', 'closed']);
  assert.equal(frames[0].payload.stepId, 's1');
  assert.equal(frames[0].payload.agent, 'research');
  assert.equal(frames[0].payload.summary, 'Found 3 competitors');
  assert.equal(frames[1].payload.error, 'rate limited', 'a failed step must carry its error text');
  assert.equal(frames[2].payload.status, 'complete');
  assert.equal(frames[2].payload.failed, 1);
  assert.equal(res.ended, true, 'a finished plan must close, not hang');
});

test('replay: orphaned running plan reports live:false and closes instead of hanging', async () => {
  cs.resetPlanStreams();
  const res = fakeRes();
  const handler = makeHandler({
    planRow: { ...finishedPlanRow, status: 'running', plan: JSON.stringify({ steps: [{ id: 's1', agent: 'research' }] }) },
  });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);

  const frames = framesOf(res);
  assert.deepEqual(frames.map(f => f.type), ['plan_state', 'closed']);
  assert.equal(frames[0].payload.status, 'running');
  assert.equal(frames[0].payload.live, false);
  assert.equal(res.ended, true);
});

test('replay: a still-building plan closes too (client falls back to polling)', async () => {
  cs.resetPlanStreams();
  const res = fakeRes();
  const handler = makeHandler({ planRow: { ...finishedPlanRow, status: 'building', plan: '{"steps":[]}' } });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);
  assert.deepEqual(framesOf(res).map(f => f.type), ['plan_state', 'closed']);
  assert.equal(res.ended, true);
});

test('replay: unparseable plan JSON degrades to plan_state instead of throwing', async () => {
  cs.resetPlanStreams();
  const res = fakeRes();
  const handler = makeHandler({ planRow: { ...finishedPlanRow, status: 'running', plan: 'not json' } });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);
  assert.deepEqual(framesOf(res).map(f => f.type), ['plan_state', 'closed']);
});

// ---------------------------------------------------------------------------
// 3. Live channel

test('live: connecting mid-run backfills history, then forwards new events', async () => {
  cs.resetPlanStreams();
  cs.openPlanStream(PLAN_ID);
  cs.emitPlanEvent(PLAN_ID, 'plan_started', { totalSteps: 2 });
  cs.emitPlanEvent(PLAN_ID, 'step_started', { stepId: 's1', agent: 'research' });

  const res = fakeRes();
  const req = fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } });
  const handler = makeHandler({ planRow: { ...finishedPlanRow, status: 'running' } });
  await handler(req, res);

  // Backfill arrived even though the client connected late.
  assert.deepEqual(framesOf(res).map(f => f.type), ['plan_started', 'step_started']);
  assert.equal(res.ended, false, 'a live plan must stay open');

  cs.emitPlanEvent(PLAN_ID, 'step_complete', { stepId: 's1', agent: 'research', summary: 'ok' });
  cs.emitPlanEvent(PLAN_ID, 'plan_complete', { status: 'complete' });
  cs.closePlanStream(PLAN_ID);

  const types = framesOf(res).map(f => f.type);
  assert.deepEqual(types, ['plan_started', 'step_started', 'step_complete', 'plan_complete', 'closed']);
  await sleep(80);
  assert.equal(res.ended, true, 'closed must end the response');
  assert.equal(cs.getPlanStream(PLAN_ID), null, 'the channel is retired after close');
  assert.equal(cs.emitPlanEvent(PLAN_ID, 'step_started', {}), null, 'emitting on a closed channel is a no-op');
});

test('live: a failed step does not end the stream', async () => {
  cs.resetPlanStreams();
  cs.openPlanStream(PLAN_ID);
  const res = fakeRes();
  const handler = makeHandler({ planRow: { ...finishedPlanRow, status: 'running' } });
  await handler(fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } }), res);

  cs.emitPlanEvent(PLAN_ID, 'step_failed', { stepId: 's1', agent: 'research', error: 'boom' });
  await sleep(60);
  assert.equal(res.ended, false, 'one failed step must not kill the whole plan stream');
  cs.emitPlanEvent(PLAN_ID, 'step_started', { stepId: 's2', agent: 'seo' });
  assert.deepEqual(framesOf(res).map(f => f.type), ['step_failed', 'step_started']);
  cs.resetPlanStreams();
});

test('live: client disconnect detaches the listener', async () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  const res = fakeRes();
  const req = fakeReq({ params: { id: PLAN_ID }, query: { token: 'good-token' } });
  const handler = makeHandler({ planRow: { ...finishedPlanRow, status: 'running' } });
  await handler(req, res);
  assert.equal(emitter.listenerCount('event'), 1);

  req.fire('close');
  assert.equal(emitter.listenerCount('event'), 0, 'listener must be removed on disconnect');
  cs.emitPlanEvent(PLAN_ID, 'step_started', { stepId: 's9' });
  assert.equal(framesOf(res).length, 0, 'no writes after the client is gone');
  cs.resetPlanStreams();
});

test('history is bounded', () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  for (let i = 0; i < cs.MAX_HISTORY + 50; i++) cs.emitPlanEvent(PLAN_ID, 'step_progress', { i });
  assert.equal(emitter.history.length, cs.MAX_HISTORY);
  assert.equal(emitter.history.at(-1).data.i, cs.MAX_HISTORY + 49);
  cs.resetPlanStreams();
});

// ---------------------------------------------------------------------------
// 4. Bridging agent runs onto the plan channel

test('bridge: one step emits started → progress → complete in order', async () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  const agentStream = new EventEmitter();
  cs.bridgeStepEvents(PLAN_ID, { id: 's1', agent: 'research', stage: 'research' }, 'run-1', agentStream);

  const emit = (type, data) => agentStream.emit('event', { type, data, timestamp: new Date().toISOString() });
  emit('started', { agent: 'research' });
  emit('progress', { step: 'searching', message: 'Scanning 12 sources' });
  emit('complete', { output: { summary: 'Three themes' }, cost: { usdCents: 7 }, durationMs: 1200 });
  emit('closed', {});

  const seen = emitter.history.map(e => e.type);
  assert.deepEqual(seen, ['step_started', 'step_progress', 'step_complete'], 'closed is plan-level, not per-step');
  const [started, progress, complete] = emitter.history;
  assert.deepEqual(
    { stepId: started.data.stepId, agent: started.data.agent, stage: started.data.stage, runId: started.data.runId },
    { stepId: 's1', agent: 'research', stage: 'research', runId: 'run-1' }
  );
  assert.equal(progress.data.message, 'Scanning 12 sources');
  assert.equal(complete.data.summary, 'Three themes');
  assert.equal(complete.data.usdCents, 7);
  cs.resetPlanStreams();
});

test('bridge: an agent error becomes step_failed carrying the message', () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  const agentStream = new EventEmitter();
  cs.bridgeStepEvents(PLAN_ID, { id: 's2', agent: 'publisher' }, 'run-2', agentStream);
  agentStream.emit('event', { type: 'error', data: { message: 'OAuth token expired' } });

  assert.deepEqual(emitter.history.map(e => e.type), ['step_failed']);
  assert.equal(emitter.history[0].data.error, 'OAuth token expired');
  assert.equal(emitter.history[0].data.stepId, 's2');
  cs.resetPlanStreams();
});

test('bridge: parallel steps keep per-step identity while interleaving', () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  const a = new EventEmitter(), b = new EventEmitter();
  cs.bridgeStepEvents(PLAN_ID, { id: 's1', agent: 'research' }, 'run-a', a);
  cs.bridgeStepEvents(PLAN_ID, { id: 's2', agent: 'seo' }, 'run-b', b);

  a.emit('event', { type: 'started', data: {} });
  b.emit('event', { type: 'started', data: {} });
  b.emit('event', { type: 'complete', data: { output: 'seo brief ready' } });
  a.emit('event', { type: 'complete', data: { output: 'research done' } });

  assert.deepEqual(
    emitter.history.map(e => `${e.type}:${e.data.stepId}`),
    ['step_started:s1', 'step_started:s2', 'step_complete:s2', 'step_complete:s1']
  );
  cs.resetPlanStreams();
});

test('bridge: detach stops translating', () => {
  cs.resetPlanStreams();
  const emitter = cs.openPlanStream(PLAN_ID);
  const agentStream = new EventEmitter();
  const detach = cs.bridgeStepEvents(PLAN_ID, { id: 's1', agent: 'research' }, 'run-1', agentStream);
  detach();
  agentStream.emit('event', { type: 'started', data: {} });
  assert.equal(emitter.history.length, 0);
  cs.resetPlanStreams();
});

// ---------------------------------------------------------------------------
// 5. Output summarizing

test('summarizeOutput picks a human field and truncates', () => {
  assert.equal(cs.summarizeOutput({ summary: 'Wrote 3 posts' }), 'Wrote 3 posts');
  assert.equal(cs.summarizeOutput('plain text'), 'plain text');
  assert.equal(cs.summarizeOutput(null), '');
  assert.equal(cs.summarizeOutput([1, 2, 3]), '3 items');
  assert.equal(cs.summarizeOutput({ posts: [1, 2], tone: 'friendly' }), 'posts: 2, tone: friendly');
  const long = cs.summarizeOutput({ text: 'x'.repeat(500) });
  assert.ok(long.length <= 180, `summary should be short, got ${long.length}`);
  assert.ok(long.endsWith('…'));
});
