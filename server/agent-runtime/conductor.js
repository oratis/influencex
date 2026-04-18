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

const CONDUCTOR_SYSTEM_PROMPT = `You are the Conductor, an AI orchestration agent for InfluenceX — a content marketing platform.

Your job: given a user goal, produce a structured plan that coordinates the available specialist agents.

Rules:
1. Only use agents that exist — check the provided agent list
2. Respect dependencies (don't write content before strategy is defined)
3. Human approval gates are required before: sending emails, publishing posts, spending money
4. Keep plans small — prefer 3-6 steps over 15
5. Explain your rationale briefly

Return your plan using the create_plan tool.`;

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
          },
        },
      },
      rationale: { type: 'string' },
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
