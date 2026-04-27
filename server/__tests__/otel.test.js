const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshOtel({ endpoint } = {}) {
  delete require.cache[require.resolve('../otel')];
  if (endpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return require('../otel');
}

beforeEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
});

test('isConfigured: false when endpoint unset', () => {
  const o = freshOtel();
  assert.equal(o.isConfigured(), false);
});

test('isConfigured: true when endpoint set', () => {
  const o = freshOtel({ endpoint: 'http://collector:4318' });
  assert.equal(o.isConfigured(), true);
});

test('init: no-op when not configured (no throw)', () => {
  const o = freshOtel();
  o.init(); // must not throw
});

test('parseHeaders: parses k=v,k2=v2 form', () => {
  const o = freshOtel();
  const h = o.parseHeaders('x-honeycomb-team=abc123,x-dataset=influencex');
  assert.equal(h['x-honeycomb-team'], 'abc123');
  assert.equal(h['x-dataset'], 'influencex');
});

test('parseHeaders: tolerates empty input', () => {
  const o = freshOtel();
  assert.deepEqual(o.parseHeaders(''), {});
  assert.deepEqual(o.parseHeaders(null), {});
  assert.deepEqual(o.parseHeaders(undefined), {});
});

test('parseHeaders: skips malformed pieces', () => {
  const o = freshOtel();
  const h = o.parseHeaders('valid=ok,nokey,=novalue,another=fine');
  assert.equal(h.valid, 'ok');
  assert.equal(h.another, 'fine');
  assert.equal(h.nokey, undefined);
});
