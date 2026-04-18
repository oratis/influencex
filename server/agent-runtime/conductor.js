/**
 * Conductor — the meta-agent that turns a natural-language goal into a
 * structured plan of agent invocations.
 *
 * Uses Claude tool-use (or OpenAI function calling) with a typed schema to
 * produce a DAG: array of steps, each referencing an available agent + input.
 * The human approves the plan before execution; the Conductor then dispatches
 * each step to the job queue.
 *
 * Example goal:
 *   "Run a 30-day launch campaign for our new AI feature targeting SaaS founders"
 *
 * Example plan:
 *   {
 *     "steps": [
 *       { "id": "s1", "agent": "strategy",   "input": { "topic": "SaaS founder AI launch" } },
 *       { "id": "s2", "agent": "research",   "input": { "topic": "..." }, "dependsOn": ["s1"] },
 *       { "id": "s3", "agent": "content-text", "input": { "brief": "..." }, "dependsOn": ["s2"] },
 *       ...
 *     ],
 *     "estimatedCostUsdCents": 2400,
 *     "estimatedDurationMinutes": 8,
 *     "rationale": "...",
 *     "humanApprovalGates": ["before send.send"]
 *   }
 */

const llm = require('../llm');
const runtime = require('./index');

const CONDUCTOR_SYSTEM_PROMPT = `You are the Conductor, the meta-agent that orchestrates specialist agents on InfluenceX — an AI content marketing platform.

Your job: turn a user's natural-language goal into a structured, executable plan.

## How to plan

1. **Pick only real agents.** Use agent ids from the provided list. Don't invent new ones.
2. **Decompose into stages.** Assign each step a \`stage\` string naming the phase it belongs to ("research", "strategy", "draft", "review", "publish", "measure"). Steps in the same stage can often run in parallel.
3. **Mark parallelism.** Steps with no dependency on each other and that do independent work (e.g. researching three different competitors, drafting X + LinkedIn in parallel) should share a \`parallel_group\` string. The executor runs same-group steps concurrently.
4. **Respect dependencies.** Use \`dependsOn\` listing step ids. Downstream creative steps ("content-text") must depend on the strategy/research steps feeding them. Reference earlier outputs in the \`input\` prose so the user can see the flow even if we don't yet thread outputs automatically.
5. **Gate risky steps.** Set \`humanApproval: true\` on any step that sends email, publishes content, spends money, or contacts third parties. List the same checkpoints in \`humanApprovalGates\` as one-line descriptions.
6. **Long-running campaigns.** For multi-week work, express cadence in the step \`input\` (e.g. "run weekly", "publish Tuesdays at 9am PT") — the platform scheduler persists these; you don't need to create duplicate steps per day.
7. **Size appropriately.** Simple asks → 3–5 steps. Complex campaigns → up to ~12 steps across 3–4 stages. Don't pad.
8. **Rationale is concrete.** One short paragraph tying the plan back to the goal — what each stage accomplishes and why this ordering.

## Agent composition hints

- Start competitive/market work with \`research\` and \`competitor-monitor\` (parallel).
- Before writing, run \`strategy\` to lock positioning, or \`brand-voice\` if voice calibration is needed.
- \`review-miner\` pairs with either our own product (for testimonials) or competitors (for gap discovery).
- \`seo\` belongs in the draft stage — its brief feeds \`content-text\`.
- Use \`kol-outreach\` + \`content-text\` (tier: "quality") for outbound campaigns.
- Publishing steps (\`publish.*\`) always need \`humanApproval: true\` unless the user explicitly authorized autopilot.

Call create_plan with your final plan.`;

const createPlanTool = {
  name: 'create_plan',
  description: 'Emit the final structured plan for the user to approve.',
  input_schema: {
    type: 'object',
    required: ['steps', 'rationale'],
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered list of agent invocations',
        items: {
          type: 'object',
          required: ['id', 'agent', 'input'],
          properties: {
            id: { type: 'string', description: 'Step id, e.g. "s1"' },
            agent: { type: 'string', description: 'Agent id from the available list' },
            input: { type: 'object', description: 'Input to pass to the agent' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            humanApproval: { type: 'boolean', description: 'Require human approval before running' },
            stage: { type: 'string', description: 'Phase label: research | strategy | draft | review | publish | measure' },
            parallel_group: { type: 'string', description: 'Steps sharing this group id run concurrently (if their dependsOn is satisfied)' },
            notes: { type: 'string', description: 'Short human-readable context for this step' },
          },
        },
      },
      rationale: { type: 'string' },
      stages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered list of stage labels this plan goes through',
      },
      humanApprovalGates: {
        type: 'array',
        items: { type: 'string' },
        description: 'Natural-language descriptions of approval checkpoints',
      },
    },
  },
};

/**
 * Build a plan for a goal using the LLM.
 *
 * @returns {Promise<{ plan, rawResponse, cost }>}
 */
async function buildPlan({ goal, workspaceId, userId }) {
  if (!goal || typeof goal !== 'string') throw new Error('Goal is required');

  const availableAgents = runtime.listAgents().map(a => ({
    id: a.id, name: a.name, description: a.description, capabilities: a.capabilities,
  }));

  const userMessage = `Goal: ${goal}

Available agents:
${availableAgents.map(a => `- ${a.id}: ${a.description}`).join('\n')}

Produce a plan that achieves the goal using these agents. Call create_plan with the result.`;

  const res = await llm.complete({
    messages: [{ role: 'user', content: userMessage }],
    system: CONDUCTOR_SYSTEM_PROMPT,
    tools: [createPlanTool],
    maxTokens: 2048,
    temperature: 0.3,
  });

  // Find the tool use response
  const toolUse = (res.toolUses || []).find(t =>
    t.name === 'create_plan' || t.type === 'tool_use' && t.name === 'create_plan'
  );
  if (!toolUse) {
    // Fallback: sometimes the model outputs JSON in text
    try {
      const match = res.text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.steps)) return { plan: parsed, rawResponse: res, cost: res.usage };
      }
    } catch {}
    throw new Error('Conductor did not produce a structured plan. Model output: ' + res.text.slice(0, 300));
  }

  const plan = toolUse.input;
  return { plan, rawResponse: res, cost: res.usage };
}

/**
 * Estimate the cost of executing a plan by summing agent cost estimates.
 */
function estimatePlanCost(plan) {
  let totalUsdCents = 0;
  let totalQuotaUnits = 0;
  for (const step of plan.steps || []) {
    const est = runtime.estimateCost(step.agent, step.input);
    if (est) {
      totalUsdCents += est.usdCents || 0;
      totalQuotaUnits += est.quotaUnits || 0;
    }
  }
  return { totalUsdCents, totalQuotaUnits };
}

module.exports = {
  buildPlan,
  estimatePlanCost,
  CONDUCTOR_SYSTEM_PROMPT,
};
