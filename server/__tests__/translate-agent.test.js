/**
 * Translate Agent scaffold tests.
 *
 * No LLM key needed — we cover input validation, metadata/schema shape, cost
 * estimates scaling with language count, and the runtime registration path.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshRuntime() {
  delete require.cache[require.resolve('../agent-runtime')];
  return require('../agent-runtime');
}

test('translate agent has expected metadata + schema', () => {
  const agent = require('../agents-v2/translate');
  assert.equal(agent.id, 'translate');
  assert.ok(agent.capabilities.includes('translate.batch'));
  assert.deepEqual(agent.inputSchema.required, ['content', 'target_languages']);
  assert.deepEqual(agent.outputSchema.required, ['source_language', 'translations']);
});

test('translate agent validates required inputs', async () => {
  const agent = require('../agents-v2/translate');
  const ctx = { emit: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };

  await assert.rejects(agent.run({}, ctx), /content is required/);
  await assert.rejects(agent.run({ content: 'hi' }, ctx), /target_languages/);
  await assert.rejects(agent.run({ content: 'hi', target_languages: [] }, ctx), /target_languages/);
});

test('costEstimate scales linearly with target_languages count', () => {
  const agent = require('../agents-v2/translate');
  const one = agent.costEstimate({ content: 'hi', target_languages: ['es'] });
  const five = agent.costEstimate({ content: 'hi', target_languages: ['es', 'fr', 'de', 'ja', 'zh-CN'] });
  assert.ok(five.tokens > one.tokens, 'more languages should estimate more tokens');
  assert.ok(five.tokens >= one.tokens + 4 * 300, 'per-language cost should contribute meaningfully');
});

test('translate agent registers with the runtime via registerAll', () => {
  const rt = freshRuntime();
  // Re-require the index module to bind it to the fresh runtime.
  delete require.cache[require.resolve('../agents-v2')];
  const { registerAll } = require('../agents-v2');
  const ids = registerAll();
  assert.ok(ids.includes('translate'), 'translate agent missing from registerAll output');
  const meta = rt.getAgent('translate');
  assert.ok(meta, 'translate agent not retrievable from runtime after register');
  assert.equal(meta.id, 'translate');
});

test('outputSchema translation entries require language + content', () => {
  const agent = require('../agents-v2/translate');
  const entrySchema = agent.outputSchema.properties.translations.items;
  assert.deepEqual(entrySchema.required, ['language', 'content']);
});
