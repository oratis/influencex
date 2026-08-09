/**
 * Conductor plan-building progress phases (roadmap B3, deliverable 2).
 *
 * `buildPlan()` is ONE blocking `llm.complete()` call and server/llm has no
 * token streaming, so the only honest progress it can report is the coarse
 * server-side phases it actually passes through. These tests pin that
 * honesty: each phase must correspond to real work, must be emitted at the
 * right moment relative to the LLM call, and must never carry an invented
 * completion percentage.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub the LLM layer before conductor.js pulls it in — no test may hit the network.
const llmPath = require.resolve('../llm');
const llmStub = {
  calls: [],
  resolveTarget: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
  complete: async (opts) => {
    llmStub.calls.push(opts);
    return llmStub.nextResponse;
  },
  isConfigured: () => true,
};
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true, children: [], parent: null,
  exports: llmStub,
};

const runtime = require('../agent-runtime');
const conductor = require('../agent-runtime/conductor');

runtime.registerAgent({ id: 'research', name: 'Research', description: 'looks things up', async run() { return {}; } });
runtime.registerAgent({ id: 'content-text', name: 'Writer', description: 'writes copy', async run() { return {}; } });

const TOOL_USE_RESPONSE = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  text: '',
  toolUses: [{
    type: 'tool_use', name: 'create_plan',
    input: { steps: [{ id: 's1', agent: 'research', input: {} }, { id: 's2', agent: 'content-text', input: {} }], rationale: 'because' },
  }],
  usage: { inputTokens: 900, outputTokens: 400, usdCents: 3 },
};

function collect() {
  const phases = [];
  return { phases, onPhase: (phase, data) => phases.push({ phase, data }) };
}

test('buildPlan reports the coarse phases it actually passes through, in order', async () => {
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const { phases, onPhase } = collect();

  const { plan } = await conductor.buildPlan({ goal: 'Launch the thing', onPhase });

  assert.deepEqual(
    phases.map(p => p.phase),
    ['collecting_agents', 'calling_llm', 'parsing_plan', 'plan_ready']
  );
  assert.equal(plan.steps.length, 2);
});

test('collecting_agents reports the real registry size', async () => {
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const { phases, onPhase } = collect();
  await conductor.buildPlan({ goal: 'g', onPhase });
  const collecting = phases.find(p => p.phase === 'collecting_agents');
  assert.equal(collecting.data.agentCount, runtime.listAgents().length);
  assert.ok(collecting.data.agentCount >= 2);
});

test('calling_llm names the provider + model and fires BEFORE the request', async () => {
  const order = [];
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const originalComplete = llmStub.complete;
  llmStub.complete = async (opts) => { order.push('llm.complete'); return originalComplete(opts); };

  const phases = [];
  await conductor.buildPlan({
    goal: 'g',
    onPhase: (phase, data) => { order.push(phase); phases.push({ phase, data }); },
  });
  llmStub.complete = originalComplete;

  assert.ok(
    order.indexOf('calling_llm') < order.indexOf('llm.complete'),
    'the user must be told who is thinking before the wait starts'
  );
  const calling = phases.find(p => p.phase === 'calling_llm');
  assert.deepEqual(calling.data, { provider: 'anthropic', model: 'claude-sonnet-4-5' });
});

test('plan_ready reports the real step count; parsing_plan carries real usage', async () => {
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const { phases, onPhase } = collect();
  await conductor.buildPlan({ goal: 'g', onPhase });
  assert.equal(phases.find(p => p.phase === 'plan_ready').data.steps, 2);
  const parsing = phases.find(p => p.phase === 'parsing_plan').data;
  assert.equal(parsing.outputTokens, 400);
  assert.equal(parsing.fromCache, false);
});

test('no phase invents a completion percentage', async () => {
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const { phases, onPhase } = collect();
  await conductor.buildPlan({ goal: 'g', onPhase });
  for (const { phase, data } of phases) {
    for (const key of Object.keys(data)) {
      assert.ok(
        !/^(percent|pct|progress|completion|eta)$/i.test(key),
        `phase "${phase}" must not fabricate progress (found "${key}")`
      );
    }
  }
});

test('the text-JSON fallback still reports plan_ready, flagged as such', async () => {
  llmStub.nextResponse = {
    provider: 'anthropic', model: 'claude-sonnet-4-5',
    text: 'Here you go: {"steps":[{"id":"s1","agent":"research","input":{}}],"rationale":"r"}',
    toolUses: [],
    usage: { inputTokens: 10, outputTokens: 20 },
  };
  const { phases, onPhase } = collect();
  const { plan } = await conductor.buildPlan({ goal: 'g', onPhase });
  assert.equal(plan.steps.length, 1);
  const ready = phases.find(p => p.phase === 'plan_ready');
  assert.equal(ready.data.steps, 1);
  assert.equal(ready.data.viaTextFallback, true);
});

test('a throwing onPhase never breaks planning, and onPhase stays optional', async () => {
  llmStub.nextResponse = TOOL_USE_RESPONSE;
  const { plan } = await conductor.buildPlan({ goal: 'g', onPhase: () => { throw new Error('reporter blew up'); } });
  assert.equal(plan.steps.length, 2);
  const noReporter = await conductor.buildPlan({ goal: 'g' });
  assert.equal(noReporter.plan.steps.length, 2);
});

test('an unparseable model response throws after reporting parsing_plan', async () => {
  llmStub.nextResponse = {
    provider: 'anthropic', model: 'claude-sonnet-4-5',
    text: 'I refuse', toolUses: [], usage: {},
  };
  const { phases, onPhase } = collect();
  await assert.rejects(
    () => conductor.buildPlan({ goal: 'g', onPhase }),
    /did not produce a structured plan/
  );
  assert.deepEqual(phases.map(p => p.phase), ['collecting_agents', 'calling_llm', 'parsing_plan']);
});
