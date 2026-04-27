const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshSentry({ dsn } = {}) {
  delete require.cache[require.resolve('../sentry')];
  if (dsn) process.env.SENTRY_DSN = dsn;
  else delete process.env.SENTRY_DSN;
  return require('../sentry');
}

beforeEach(() => {
  delete process.env.SENTRY_DSN;
});

test('isConfigured: false when SENTRY_DSN unset', () => {
  const s = freshSentry();
  assert.equal(s.isConfigured(), false);
});

test('isConfigured: true when SENTRY_DSN set', () => {
  const s = freshSentry({ dsn: 'https://x@o0.ingest.sentry.io/0' });
  assert.equal(s.isConfigured(), true);
});

test('init: no-op when not configured (no throw)', () => {
  const s = freshSentry();
  s.init(); // must not throw
  s.captureException(new Error('hi')); // must not throw
  s.captureMessage('hi'); // must not throw
  s.setUser({ id: 'u1' }); // must not throw
  s.setupExpressRequestHandler({}); // must not throw
  s.setupExpressErrorHandler({}); // must not throw
});

test('captureException: forwards to injected SDK with workspace tag', () => {
  const s = freshSentry();
  let captured = null;
  let scopeOps = [];
  const fakeScope = {
    setTag: (k, v) => { scopeOps.push(['tag', k, v]); return fakeScope; },
    setUser: (u) => { scopeOps.push(['user', u]); return fakeScope; },
    setExtra: (k, v) => { scopeOps.push(['extra', k, v]); return fakeScope; },
  };
  s._injectSdkForTest({
    captureException: (err, fn) => {
      captured = err;
      // v9-style scope callback: invoke with our fake scope.
      if (typeof fn === 'function') fn(fakeScope);
    },
    captureMessage: () => {},
    setUser: () => {},
    setupExpressErrorHandler: () => {},
  });

  s.captureException(new Error('boom'), {
    workspace_id: 'ws-7',
    user_id: 'u-9',
    tags: { actor: 'apify/x' },
    extra: { jobId: 'j1' },
  });

  assert.ok(captured);
  assert.equal(captured.message, 'boom');
  // workspace_id + tags applied
  assert.deepEqual(scopeOps.find(o => o[0] === 'tag' && o[1] === 'workspace_id'), ['tag', 'workspace_id', 'ws-7']);
  assert.deepEqual(scopeOps.find(o => o[0] === 'tag' && o[1] === 'actor'), ['tag', 'actor', 'apify/x']);
  // extra applied
  assert.deepEqual(scopeOps.find(o => o[0] === 'extra' && o[1] === 'jobId'), ['extra', 'jobId', 'j1']);
});

test('captureException: silently swallows SDK throws (does not break callers)', () => {
  const s = freshSentry();
  s._injectSdkForTest({
    captureException: () => { throw new Error('SDK exploded'); },
    setUser: () => {},
    captureMessage: () => {},
    setupExpressErrorHandler: () => {},
  });
  // Must NOT throw — Sentry's job is to observe, never to break the app.
  s.captureException(new Error('original'));
});

test('setUser: forwards id + email only (PII safe by default)', () => {
  const s = freshSentry();
  let captured = null;
  s._injectSdkForTest({
    setUser: (u) => { captured = u; },
    captureException: () => {},
    captureMessage: () => {},
    setupExpressErrorHandler: () => {},
  });
  s.setUser({ id: 'u-1', email: 'a@b.c', password_hash: 'should-not-leak', ssn: '123-45-6789' });
  assert.deepEqual(captured, { id: 'u-1', email: 'a@b.c' });
});

test('setUser(null): clears user', () => {
  const s = freshSentry();
  let captured = 'untouched';
  s._injectSdkForTest({
    setUser: (u) => { captured = u; },
    captureException: () => {},
    captureMessage: () => {},
    setupExpressErrorHandler: () => {},
  });
  s.setUser(null);
  assert.equal(captured, null);
});

test('setupExpressErrorHandler: invokes SDK when initialized', () => {
  const s = freshSentry();
  let called = false;
  s._injectSdkForTest({
    setupExpressErrorHandler: () => { called = true; },
    captureException: () => {},
    captureMessage: () => {},
    setUser: () => {},
  });
  s.setupExpressErrorHandler({});
  assert.equal(called, true);
});
