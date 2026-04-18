/**
 * Agent runtime — the foundation of InfluenceX v2.
 *
 * Every capability (content generation, creator discovery, outreach, etc) is
 * implemented as an Agent conforming to a standard interface. The runtime
 * provides:
 *   - Agent registration + discovery
 *   - Lifecycle management (start, progress, complete, fail, retry)
 *   - Event streaming (SSE-friendly)
 *   - Cost accounting per run
 *   - Trace persistence for audit and debugging
 *
 * Agent contract:
 *
 *   interface Agent {
 *     id: string              // unique identifier, e.g. "content-text"
 *     name: string            // human-readable
 *     description: string     // what it does
 *     version: string         // semver; lets us A/B test agents
 *     capabilities: string[]  // e.g. ["write.twitter", "write.blog"]
 *     inputSchema: JSONSchema // what it accepts
 *     outputSchema: JSONSchema
 *     costEstimate?(input) → { tokens: number, usdCents: number }
 *     run(input, ctx): AsyncIterable<Event> | Promise<Output>
 *   }
 *
 * Events streamed during run:
 *   { type: 'started',  data: {} }
 *   { type: 'progress', data: { step: string, message?: string } }
 *   { type: 'thinking', data: { thought: string } }       // optional
 *   { type: 'tool_call', data: { tool: string, args: any, result?: any } }
 *   { type: 'partial',  data: { text: string } }          // streaming output
 *   { type: 'human_approval_required', data: { prompt: string, defaultValue?: any } }
 *   { type: 'complete', data: { output: any, cost: { tokens, usdCents } } }
 *   { type: 'error',    data: { message, code?, retryable? } }
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

// In-memory registry. For scale: move to a DB table, cache warmed at boot.
const registry = new Map();
const streamers = new Map(); // runId → EventEmitter

/**
 * Register an agent. Agents can be registered at boot or hot-loaded via plugins.
 */
function registerAgent(agent) {
  if (!agent || typeof agent.run !== 'function') {
    throw new Error('Agent must have a run() method');
  }
  if (!agent.id) throw new Error('Agent must have an id');
  if (registry.has(agent.id)) {
    throw new Error(`Agent "${agent.id}" already registered`);
  }
  registry.set(agent.id, {
    id: agent.id,
    name: agent.name || agent.id,
    description: agent.description || '',
    version: agent.version || '0.1.0',
    capabilities: agent.capabilities || [],
    inputSchema: agent.inputSchema || { type: 'object' },
    outputSchema: agent.outputSchema || { type: 'object' },
    costEstimate: agent.costEstimate,
    run: agent.run,
  });
  return agent;
}

function listAgents() {
  return Array.from(registry.values()).map(({ run, ...meta }) => meta);
}

function getAgent(id) {
  const a = registry.get(id);
  if (!a) return null;
  const { run, ...meta } = a;
  return meta;
}

/**
 * Create a run for an agent. Returns { runId, stream } where stream is an
 * EventEmitter emitting the event types listed in the module doc.
 *
 * This is a *pure* runtime — persistence of the run and its events to the
 * agent_runs / agent_traces tables is the caller's responsibility (see
 * server/index.js handler).
 */
function createRun(agentId, input, ctx = {}) {
  const agent = registry.get(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const runId = uuidv4();
  const emitter = new EventEmitter();
  streamers.set(runId, emitter);

  const runCtx = {
    runId,
    workspaceId: ctx.workspaceId || null,
    userId: ctx.userId || null,
    emit: (type, data) => emitter.emit('event', { type, data, timestamp: new Date().toISOString() }),
    logger: {
      info: (...args) => console.log(`[agent:${agentId} run:${runId.slice(0, 8)}]`, ...args),
      warn: (...args) => console.warn(`[agent:${agentId} run:${runId.slice(0, 8)}]`, ...args),
      error: (...args) => console.error(`[agent:${agentId} run:${runId.slice(0, 8)}]`, ...args),
    },
    ...ctx,
  };

  // Kick off the run asynchronously; the caller wires the emitter to SSE.
  // setImmediate gives the caller one turn of the event loop to attach listeners
  // before any event fires. Without this, synchronous agents race the listener attach.
  setImmediate(async () => {
    const startedAt = Date.now();
    let cost = { tokens: 0, usdCents: 0 };
    try {
      runCtx.emit('started', { agent: agentId, input });
      const result = agent.run(input, runCtx);

      // Support both async-iterator agents and promise-returning agents
      let output;
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        for await (const event of result) {
          if (event?.type === 'complete') {
            output = event.data?.output;
            if (event.data?.cost) cost = event.data.cost;
          }
          emitter.emit('event', { ...event, timestamp: new Date().toISOString() });
        }
      } else {
        output = await result;
        // Promise-returning agents can attach their own cost to the output.
        // We recognize `output.cost` with { inputTokens, outputTokens, usdCents }.
        if (output && typeof output === 'object' && output.cost) {
          cost = {
            tokens: (output.cost.inputTokens || 0) + (output.cost.outputTokens || 0),
            inputTokens: output.cost.inputTokens || 0,
            outputTokens: output.cost.outputTokens || 0,
            usdCents: output.cost.usdCents || 0,
          };
        }
      }

      if (output !== undefined) {
        runCtx.emit('complete', { output, cost, durationMs: Date.now() - startedAt });
      }
    } catch (e) {
      runCtx.emit('error', {
        message: e.message || String(e),
        code: e.code,
        retryable: e.retryable === true,
      });
    } finally {
      // Close the stream after a short delay so SSE clients can flush
      setTimeout(() => {
        emitter.emit('event', { type: 'closed', data: {}, timestamp: new Date().toISOString() });
        emitter.removeAllListeners();
        streamers.delete(runId);
      }, 100);
    }
  });

  return { runId, stream: emitter };
}

function getRunStream(runId) {
  return streamers.get(runId) || null;
}

function estimateCost(agentId, input) {
  const agent = registry.get(agentId);
  if (!agent || !agent.costEstimate) return null;
  try {
    return agent.costEstimate(input);
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  registerAgent,
  listAgents,
  getAgent,
  createRun,
  getRunStream,
  estimateCost,
};
