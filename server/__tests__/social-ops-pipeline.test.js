const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pipeline } = require('../../packages/social-ops');
const { runContentPipeline, createLexiconGate, extractJson } = pipeline;

/** A scripted LLM: answers by stage keyword in the system prompt. */
function fakeLlm(overrides = {}) {
  const calls = [];
  return {
    calls,
    complete: async ({ system, messages }) => {
      calls.push({ system, user: messages[0].content });
      const usage = { inputTokens: 10, outputTokens: 5, usdCents: 1 };
      if (/strategist/.test(system)) return { text: JSON.stringify(overrides.plan || { angle: 'A', hook: 'Hook line', outline: ['a', 'b'], hashtags: ['#story', 'ai'], visualBrief: 'a bear', titleIdeas: ['T1'] }), usage };
      if (/fix social copy/.test(system)) return { text: '```json\n' + JSON.stringify(overrides.rewrite || { title: 'Clean', body: 'Clean body', cta: 'Go' }) + '\n```', usage };
      if (/write social copy/.test(system)) {
        const m = messages[0].content.match(/LANGUAGE: (\w+)/);
        return { text: JSON.stringify(overrides.write ? overrides.write(m[1]) : { title: `Title ${m[1]}`, body: `Body ${m[1]}`, cta: 'Try it' }), usage };
      }
      throw new Error('unexpected stage');
    },
  };
}

test('extractJson tolerates fences and prose around the object', () => {
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n``` done'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a":{"b":2}} suffix'), { a: { b: 2 } });
  assert.equal(extractJson('nope'), null);
});

test('lexicon gate: whole-word for latin, substring for CJK, regex patterns', () => {
  const gate = createLexiconGate({ banned: ['companion', '伴侣'], patterns: ['girl\\s*friend'] });
  assert.equal(gate('a companionship app').ok, true);
  assert.equal(gate('your AI companion').ok, false);
  assert.equal(gate('你的AI伴侣').ok, false);
  assert.equal(gate('meet your girl friend').ok, false);
  assert.deepEqual(gate('clean').hits, []);
});

test('pipeline: plan → write per locale → adapt per platform, hashtags + link injected, cost summed', async () => {
  const llm = fakeLlm();
  const out = await runContentPipeline({
    brief: { topic: 'EP03 drop', cta: 'Watch now', link: 'https://cuddler.ai/s/abc?utm_content=p1', brandVoice: 'warm' },
    platforms: ['x', 'xiaohongshu', 'youtube'],
    locales: ['en', 'zh'],
    assets: { videoUrl: 'https://x/v.mp4' },
  }, { llm });
  assert.equal(out.plan.hashtags[0], 'story');
  assert.equal(out.variants.length, 6);
  const xEn = out.variants.find((v) => v.platform === 'x' && v.locale === 'en');
  assert.ok(xEn.text.includes('Body en'));
  assert.ok(xEn.text.includes('#story #ai'));
  assert.ok(xEn.text.includes('utm_content=p1'));
  assert.equal(xEn.gate.ok, true);
  const xhsZh = out.variants.find((v) => v.platform === 'xiaohongshu' && v.locale === 'zh');
  assert.equal(xhsZh.mode, 'manual_package');
  assert.ok(xhsZh.package.body.includes('Body zh'));
  const yt = out.variants.find((v) => v.platform === 'youtube' && v.locale === 'en');
  assert.equal(yt.videoUrl, 'https://x/v.mp4');
  assert.equal(out.cost.calls, 3); // plan + 2 writes
  assert.equal(out.cost.usdCents, 3);
  assert.deepEqual(out.blocked, []);
});

test('pipeline: gate blocks a banned term after adaptation, one rewrite is attempted, residue is reported not dropped', async () => {
  const llm = fakeLlm({ write: () => ({ title: 'Meet your companion', body: 'Your AI companion is here', cta: '' }), rewrite: { title: 'Meet your cast', body: 'Your AI companion is here', cta: '' } });
  const events = [];
  const out = await runContentPipeline({
    brief: { topic: 'launch' },
    platforms: ['x'],
    lexicon: { banned: ['companion'] },
    maxGateRetries: 1,
  }, { llm, emit: (t, d) => events.push({ t, d }) });
  assert.equal(out.variants.length, 1);
  assert.equal(out.variants[0].gate.ok, false);
  assert.equal(out.variants[0].gate.rewrites, 1);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].hits[0].term, 'companion');
  assert.ok(events.some((e) => e.d && e.d.step === 'rewrite'));
  assert.ok(llm.calls.some((c) => /fix social copy/.test(c.system)));
});

test('pipeline: rewrite that clears the gate passes; imageGen fills missing visuals', async () => {
  const llm = fakeLlm({ write: () => ({ title: 'companion', body: 'x', cta: '' }), rewrite: { title: 'cast', body: 'x', cta: '' } });
  const out = await runContentPipeline({ brief: { topic: 't' }, platforms: ['discord'], lexicon: { banned: ['companion'] } }, {
    llm,
    imageGen: async ({ prompt }) => ({ url: `https://img/${encodeURIComponent(prompt.slice(0, 6))}` }),
  });
  assert.equal(out.variants[0].gate.ok, true);
  assert.equal(out.variants[0].gate.rewrites, 1);
  assert.ok(out.generatedVisual && out.generatedVisual.url.startsWith('https://img/'));
  assert.deepEqual(out.assets.imageUrls, [out.generatedVisual.url]);
});

test('pipeline: input validation', async () => {
  await assert.rejects(() => runContentPipeline({ brief: {}, platforms: ['x'] }, { llm: fakeLlm() }), /brief\.topic/);
  await assert.rejects(() => runContentPipeline({ brief: { topic: 't' }, platforms: ['myspace'] }, { llm: fakeLlm() }), /supported platform/);
  await assert.rejects(() => runContentPipeline({ brief: { topic: 't' }, platforms: ['x'] }, {}), /deps\.llm/);
});
