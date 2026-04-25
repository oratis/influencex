const { test } = require('node:test');
const assert = require('node:assert');
const metrics = require('../metrics');

test('counter() increments and shows up in render via fake handler', async () => {
  metrics.counter('influencex_test_counter', { kind: 'a' });
  metrics.counter('influencex_test_counter', { kind: 'a' });
  metrics.counter('influencex_test_counter', { kind: 'b' }, 5);

  // Trigger a render via the Express handler.
  process.env.METRICS_TOKEN = 'secret';
  const req = { query: { token: 'secret' }, headers: {} };
  let body = '';
  let status = 200;
  const res = {
    setHeader() {},
    send(b) { body = b; },
    status(s) { status = s; return res; },
    json(obj) { body = JSON.stringify(obj); },
  };
  const handler = metrics.metricsHandler({ jobQueue: null, llm: null });
  handler(req, res);

  assert.strictEqual(status, 200);
  assert.match(body, /influencex_process_uptime_seconds/);
  // The custom counter we bumped above isn't part of the canonical render
  // (only http_* are), so we verify via the in-process map directly.
  assert.strictEqual(metrics._counters.get('influencex_test_counter{kind="a"}'), 2);
  assert.strictEqual(metrics._counters.get('influencex_test_counter{kind="b"}'), 5);
});

test('metricsHandler returns 503 when METRICS_TOKEN unset', () => {
  delete process.env.METRICS_TOKEN;
  let status = 200;
  const res = {
    setHeader() {},
    send() {},
    status(s) { status = s; return res; },
    json() {},
  };
  const handler = metrics.metricsHandler({});
  handler({ query: {}, headers: {} }, res);
  assert.strictEqual(status, 503);
});

test('metricsHandler returns 401 with wrong token', () => {
  process.env.METRICS_TOKEN = 'real';
  let status = 200;
  const res = {
    setHeader() {},
    send() {},
    status(s) { status = s; return res; },
    json() {},
  };
  const handler = metrics.metricsHandler({});
  handler({ query: { token: 'wrong' }, headers: {} }, res);
  assert.strictEqual(status, 401);
});

test('httpMetricsMiddleware records request count + latency on res finish', async () => {
  const before = metrics._counters.size;
  // Fake express req/res — we listen for 'finish' via res.once.
  const listeners = {};
  const req = { method: 'GET', route: { path: '/api/test' }, path: '/api/test' };
  const res = {
    statusCode: 200,
    once(event, fn) { listeners[event] = fn; },
  };
  let nextCalled = false;
  metrics.httpMetricsMiddleware(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'middleware must call next()');
  // Simulate response finish synchronously.
  listeners.finish?.();

  const reqCount = metrics._counters.get('influencex_http_requests_total{method="GET",route="/api/test",status="200"}');
  assert.ok(reqCount >= 1, 'request counter should bump');

  const latencyCount = metrics._counters.get('influencex_http_request_duration_seconds_count{method="GET",route="/api/test",status="200"}');
  assert.ok(latencyCount >= 1, 'latency count should bump');
});
