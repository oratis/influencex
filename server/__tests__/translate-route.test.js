/**
 * Tests for the promise-wrap pattern used by POST /api/translate.
 *
 * We register a mock translate agent against a fresh runtime to verify the
 * wrap resolves on 'complete' with the translations payload and rejects on
 * 'error'. No LLM key required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshRuntime() {
  delete require.cache[require.resolve('../agent-runtime')];
  return require('../agent-runtime');
}

function awaitRunResult(stream) {
  return new Promise((resolve, reject) => {
    stream.on('event', (evt) => {
      if (evt.type === 'complete') resolve({ output: evt.data?.output, cost: evt.data?.cost });
      else if (evt.type === 'error') reject(new Error(evt.data?.message || 'agent error'));
    });
  });
}

test('translate promise-wrap resolves with translations payload', async () => {
  const rt = freshRuntime();
  const mockOutput = {
    source_language: 'en',
    translations: [
      { language: 'es', content: 'Hola mundo', char_count: 11 },
      { language: 'fr', content: 'Bonjour le monde', char_count: 16 },
    ],
  };
  rt.registerAgent({
    id: 'translate',
    name: 'MockTranslate',
    async run() { return mockOutput; },
  });

  const { stream } = rt.createRun('translate', {
    content: 'hello world',
    target_languages: ['es', 'fr'],
  }, {});
  const r = await awaitRunResult(stream);
  assert.equal(r.output.source_language, 'en');
  assert.equal(r.output.translations.length, 2);
  assert.equal(r.output.translations[0].language, 'es');
});

test('translate promise-wrap rejects when agent throws validation error', async () => {
  const rt = freshRuntime();
  rt.registerAgent({
    id: 'translate',
    name: 'MockTranslate',
    async run() { throw new Error('target_languages (non-empty array) is required'); },
  });
  const { stream } = rt.createRun('translate', { content: 'hi', target_languages: [] }, {});
  await assert.rejects(awaitRunResult(stream), /target_languages/);
});
