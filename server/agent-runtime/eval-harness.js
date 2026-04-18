/**
 * Agent evaluation harness.
 *
 * Each agent can have an `evals.js` file next to it with an array of test
 * cases. The harness runs them against the agent, checks output structure
 * + optional predicates, and returns a pass/fail report.
 *
 * Test case shape:
 *   {
 *     name: string,
 *     input: any,
 *     assertions: [
 *       { type: 'output-shape', schema: JSONSchema },
 *       { type: 'contains', path: 'body', substring: 'InfluenceX' },
 *       { type: 'cost-ceiling', maxUsdCents: 50 },
 *       { type: 'custom', fn: (output) => true|false|string }
 *     ]
 *   }
 *
 * Run: `node -e "require('./server/agent-runtime/eval-harness').runAll()"`
 */

const path = require('path');
const fs = require('fs');
const agentRuntime = require('./index');

/**
 * Simple JSON schema checker for the common cases we care about.
 * Supports: type, required, properties, items (recursive), enum.
 */
function validateSchema(value, schema) {
  const errors = [];
  if (!schema) return errors;
  const expectedType = schema.type;
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (expectedType && actualType !== expectedType && !(expectedType === 'number' && actualType === 'number')) {
    errors.push(`expected ${expectedType}, got ${actualType}`);
    return errors;
  }
  if (expectedType === 'object' && schema.required) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`missing required property: ${key}`);
    }
  }
  if (expectedType === 'object' && schema.properties && typeof value === 'object') {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) {
        const subErrors = validateSchema(value[k], sub);
        errors.push(...subErrors.map(e => `${k}.${e}`));
      }
    }
  }
  if (expectedType === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => {
      const subErrors = validateSchema(item, schema.items);
      errors.push(...subErrors.map(e => `[${i}].${e}`));
    });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`value "${value}" not in enum [${schema.enum.join(', ')}]`);
  }
  return errors;
}

function assertOutputShape(output, schema) {
  const errors = validateSchema(output, schema);
  if (errors.length) return { ok: false, reason: 'shape errors: ' + errors.slice(0, 3).join('; ') };
  return { ok: true };
}

function assertContains(output, path, substring) {
  const parts = path.split('.');
  let cur = output;
  for (const p of parts) {
    if (cur == null) return { ok: false, reason: `path ${path} missing` };
    cur = cur[p];
  }
  if (typeof cur !== 'string') return { ok: false, reason: `path ${path} is not a string` };
  if (!cur.toLowerCase().includes(substring.toLowerCase())) {
    return { ok: false, reason: `"${substring}" not found in ${path}` };
  }
  return { ok: true };
}

function assertCostCeiling(metrics, maxUsdCents) {
  if ((metrics.cost?.usdCents || 0) > maxUsdCents) {
    return { ok: false, reason: `cost ${metrics.cost.usdCents}¢ exceeds ceiling ${maxUsdCents}¢` };
  }
  return { ok: true };
}

/**
 * Run a single test case against an agent.
 */
async function runCase(agentId, testCase) {
  const result = { name: testCase.name, agent: agentId, passed: false, assertions: [], durationMs: 0 };
  const start = Date.now();

  const { stream } = agentRuntime.createRun(agentId, testCase.input, {
    workspaceId: 'eval-workspace',
    userId: 'eval-user',
  });

  let output = null;
  let error = null;
  let cost = { usdCents: 0, tokens: 0 };

  await new Promise((resolve) => {
    stream.on('event', (evt) => {
      if (evt.type === 'complete') {
        output = evt.data.output;
        cost = evt.data.cost || cost;
      }
      if (evt.type === 'error') error = evt.data;
      if (evt.type === 'closed') resolve();
    });
  });

  result.durationMs = Date.now() - start;
  result.output = output;

  if (error) {
    result.passed = false;
    result.error = error.message;
    return result;
  }

  const metrics = { cost };
  for (const assertion of testCase.assertions || []) {
    let r;
    if (assertion.type === 'output-shape') r = assertOutputShape(output, assertion.schema);
    else if (assertion.type === 'contains') r = assertContains(output, assertion.path, assertion.substring);
    else if (assertion.type === 'cost-ceiling') r = assertCostCeiling(metrics, assertion.maxUsdCents);
    else if (assertion.type === 'custom') {
      try {
        const ret = await assertion.fn(output, metrics);
        r = ret === true ? { ok: true } : { ok: false, reason: ret || 'custom assertion failed' };
      } catch (e) { r = { ok: false, reason: `custom threw: ${e.message}` }; }
    }
    else r = { ok: false, reason: `unknown assertion type ${assertion.type}` };
    result.assertions.push({ type: assertion.type, ...r });
  }

  result.passed = result.assertions.every(a => a.ok);
  return result;
}

/**
 * Discover + run all evals under server/agents-v2/*.evals.js
 */
async function runAll({ agentIds, verbose = true } = {}) {
  const agentsDir = path.join(__dirname, '..', 'agents-v2');
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.evals.js'));
  const results = [];
  let passed = 0, failed = 0;

  for (const f of files) {
    const agentId = f.replace('.evals.js', '');
    if (agentIds && !agentIds.includes(agentId)) continue;
    const cases = require(path.join(agentsDir, f));
    if (verbose) console.log(`\n=== Agent: ${agentId} (${cases.length} cases) ===`);
    for (const c of cases) {
      const r = await runCase(agentId, c);
      results.push(r);
      if (r.passed) { passed++; if (verbose) console.log(`  ✓ ${c.name} (${r.durationMs}ms)`); }
      else {
        failed++;
        if (verbose) {
          console.log(`  ✗ ${c.name}`);
          if (r.error) console.log(`    error: ${r.error}`);
          for (const a of r.assertions) {
            if (!a.ok) console.log(`    • ${a.type}: ${a.reason}`);
          }
        }
      }
    }
  }

  if (verbose) {
    console.log(`\nTotal: ${passed}/${passed + failed} passed`);
  }
  return { passed, failed, results };
}

module.exports = { runCase, runAll, validateSchema };
