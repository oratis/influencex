const { test } = require('node:test');
const assert = require('node:assert/strict');

// Force llm to "not configured" for the no-LLM tests below.
function freshCommunity() {
  delete require.cache[require.resolve('../llm')];
  delete require.cache[require.resolve('../agents-v2/community')];
  return require('../agents-v2/community');
}

test('community agent: contract shape', () => {
  const agent = require('../agents-v2/community');
  assert.equal(agent.id, 'community');
  assert.ok(agent.capabilities.includes('community.fetch'));
  assert.ok(agent.capabilities.includes('community.classify'));
  assert.ok(agent.capabilities.includes('community.draft_reply'));
  assert.equal(typeof agent.run, 'function');
});

test('community agent: unknown action throws', async () => {
  const agent = require('../agents-v2/community');
  await assert.rejects(() => agent.run({ action: 'explode' }, { emit: () => {} }), /Unknown action/);
});

test('community agent: draft action requires inbox_message_id', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const agent = freshCommunity();
  await assert.rejects(
    () => agent.run({ action: 'draft' }, { emit: () => {}, db: { queryOne: async () => null } }),
    /inbox_message_id is required/
  );
  delete process.env.ANTHROPIC_API_KEY;
});

test('community agent: fetch skips platforms with no connection and returns fetched=0', async () => {
  const agent = require('../agents-v2/community');
  const db = {
    queryOne: async () => null,       // no connection
    query: async () => ({ rows: [] }),
    exec: async () => ({ rowCount: 0 }),
  };
  const events = [];
  const ctx = {
    db, workspaceId: 'ws-1', uuidv4: () => 'x',
    emit: (type, data) => events.push({ type, data }),
  };
  const r = await agent.run({ action: 'fetch', platforms: ['twitter', 'linkedin'] }, ctx);
  assert.equal(r.action, 'fetch');
  assert.equal(r.fetched, 0);
  // Should have emitted a "skip" for both platforms (twitter = no conn, linkedin = not implemented either way)
  assert.ok(events.some(e => e.data?.message?.includes('not connected')));
});

test('community agent: classify short-circuits when no open unclassified rows', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const agent = freshCommunity();
  const db = {
    query: async () => ({ rows: [] }),
    queryOne: async () => null,
    exec: async () => ({ rowCount: 0 }),
  };
  const r = await agent.run(
    { action: 'classify', limit: 10 },
    { db, workspaceId: 'ws-1', emit: () => {} }
  );
  assert.equal(r.classified, 0);
  delete process.env.ANTHROPIC_API_KEY;
});

test('community agent: registers with the runtime', () => {
  delete require.cache[require.resolve('../agent-runtime')];
  const runtime = require('../agent-runtime');
  const { registerAll } = require('../agents-v2');
  const ids = registerAll();
  assert.ok(ids.includes('community'));
  assert.ok(runtime.getAgent('community'));
});
