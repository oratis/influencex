const { test } = require('node:test');
const assert = require('node:assert/strict');

// Reload the module fresh for each test to reset the registry
function freshRuntime() {
  delete require.cache[require.resolve('../agent-runtime')];
  return require('../agent-runtime');
}

test('registerAgent + listAgents + getAgent', () => {
  const rt = freshRuntime();
  const a = {
    id: 'test-agent',
    name: 'Test',
    description: 'A test agent',
    capabilities: ['test.noop'],
    async run() { return { ok: true }; },
  };
  rt.registerAgent(a);
  const list = rt.listAgents();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'test-agent');
  assert.ok(!('run' in list[0]), 'list should not expose run fn');
  const fetched = rt.getAgent('test-agent');
  assert.equal(fetched.id, 'test-agent');
  assert.equal(rt.getAgent('missing'), null);
});

test('duplicate registration throws', () => {
  const rt = freshRuntime();
  rt.registerAgent({ id: 'dup', name: 'D', async run() { return {}; } });
  assert.throws(() => rt.registerAgent({ id: 'dup', name: 'D', async run() { return {}; } }), /already registered/);
});

test('registering without run() throws', () => {
  const rt = freshRuntime();
  assert.throws(() => rt.registerAgent({ id: 'no-run', name: 'X' }), /run\(\)/);
});

test('createRun emits started → complete for simple agent', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'simple',
    name: 'S',
    async run() { return { answer: 42 }; },
  });
  const { runId, stream } = rt.createRun('simple', { q: 'hi' }, {});
  const events = [];
  await new Promise((resolve) => {
    stream.on('event', (e) => {
      events.push(e.type);
      if (e.type === 'closed') resolve();
    });
  });
  assert.ok(events.includes('started'));
  assert.ok(events.includes('complete'));
  assert.ok(events.includes('closed'));
  assert.ok(runId.length > 8);
});

test('createRun emits error when agent throws', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'broken',
    name: 'B',
    async run() { throw new Error('kaboom'); },
  });
  const { stream } = rt.createRun('broken', {}, {});
  const events = [];
  await new Promise((resolve) => {
    stream.on('event', (e) => {
      events.push(e);
      if (e.type === 'closed') resolve();
    });
  });
  const err = events.find(e => e.type === 'error');
  assert.ok(err);
  assert.match(err.data.message, /kaboom/);
});

test('createRun supports async-iterator agents that stream progress', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'streamer',
    name: 'S',
    async *run() {
      yield { type: 'progress', data: { step: 'a' } };
      yield { type: 'progress', data: { step: 'b' } };
      yield { type: 'complete', data: { output: { done: true }, cost: { tokens: 100, usdCents: 2 } } };
    },
  });
  const { stream } = rt.createRun('streamer', {}, {});
  const events = [];
  await new Promise((resolve) => {
    stream.on('event', (e) => {
      events.push(e);
      if (e.type === 'closed') resolve();
    });
  });
  const progressCount = events.filter(e => e.type === 'progress').length;
  assert.equal(progressCount, 2);
  const done = events.find(e => e.type === 'complete');
  assert.deepEqual(done.data.output, { done: true });
});

test('costEstimate returns agent-specific estimate', () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'priced',
    name: 'P',
    costEstimate: (input) => ({ usdCents: input.size * 5, tokens: input.size * 100 }),
    async run() { return {}; },
  });
  const est = rt.estimateCost('priced', { size: 3 });
  assert.equal(est.usdCents, 15);
  assert.equal(est.tokens, 300);
  // Unknown agent returns null
  assert.equal(rt.estimateCost('missing', {}), null);
});

test('ctx.emit works inside run()', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'emitter',
    name: 'E',
    async run(input, ctx) {
      ctx.emit('progress', { step: 'mid' });
      return { ok: true };
    },
  });
  const { stream } = rt.createRun('emitter', {}, {});
  const events = [];
  await new Promise((resolve) => {
    stream.on('event', (e) => { events.push(e); if (e.type === 'closed') resolve(); });
  });
  const progress = events.find(e => e.type === 'progress');
  assert.ok(progress);
  assert.equal(progress.data.step, 'mid');
});

test('getRunStream returns null for unknown run', () => {
  const rt = freshRuntime();
  assert.equal(rt.getRunStream('nonexistent'), null);
});

test('createRun passes workspaceId/userId into ctx', async () => {
  const rt = freshRuntime();
  let seenCtx = null;
  rt.registerAgent({
    id: 'ctx-check',
    name: 'C',
    async run(_input, ctx) { seenCtx = ctx; return { ok: true }; },
  });
  const { stream } = rt.createRun('ctx-check', {}, { workspaceId: 'ws_abc', userId: 'u_xyz' });
  await new Promise((resolve) => {
    stream.on('event', (e) => { if (e.type === 'closed') resolve(); });
  });
  assert.equal(seenCtx.workspaceId, 'ws_abc');
  assert.equal(seenCtx.userId, 'u_xyz');
});
