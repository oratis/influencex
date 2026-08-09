/**
 * Bucket-isolation tests for the in-process rate limiter.
 *
 * rate-limit.js used to key its bucket map on the request key alone, so every
 * limiter built with the default IP keyFn — auth (10/min), discovery (5/min),
 * export (10/min), sendEmail (20/min) — drew from ONE sliding window per IP.
 * Consequences: five discovery calls ate half the login budget, and the
 * tightest `max` effectively governed all of them. Each rateLimit() instance
 * now gets its own namespace.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit, consume } = require('../rate-limit');

const WINDOW = 60 * 1000;

function run(limiter, ip) {
  const req = { ip, headers: {} };
  let status = 200;
  const res = {
    set() { return res; },
    status(c) { status = c; return res; },
    json() { return res; },
  };
  let passed = false;
  limiter(req, res, () => { passed = true; });
  return { passed, status };
}

test('two limiters with the default keyFn do not share a window', () => {
  const a = rateLimit({ max: 3, windowMs: WINDOW });
  const b = rateLimit({ max: 3, windowMs: WINDOW });
  const ip = '198.51.100.10';

  for (let i = 0; i < 3; i++) assert.equal(run(a, ip).passed, true);
  assert.equal(run(a, ip).passed, false, 'limiter A is exhausted');
  assert.equal(run(b, ip).passed, true, 'limiter B must be untouched');
});

test('the tightest limiter no longer governs the others', () => {
  // Mirrors the real config: discovery is 5/min, auth is 10/min, same IP.
  const discovery = rateLimit({ name: 'discovery', max: 5, windowMs: WINDOW });
  const auth = rateLimit({ name: 'auth', max: 10, windowMs: WINDOW });
  const ip = '198.51.100.11';

  for (let i = 0; i < 5; i++) run(discovery, ip);
  assert.equal(run(discovery, ip).passed, false, 'discovery budget spent');
  for (let i = 0; i < 10; i++) {
    assert.equal(run(auth, ip).passed, true, `auth request ${i + 1} must pass`);
  }
  assert.equal(run(auth, ip).passed, false, 'auth has its own full budget, then stops');
});

test('same name = shared window (opt-in, used by batch-send)', () => {
  const mw = rateLimit({ name: 'shared-window-test', max: 4, windowMs: WINDOW });
  const ip = '198.51.100.12';
  run(mw, ip);
  run(mw, ip);

  // consume() must land in the SAME bucket as the middleware it shadows,
  // otherwise a batch reservation is written where nothing ever checks it.
  const r = consume({ name: 'shared-window-test', key: ip, n: 2, max: 4, windowMs: WINDOW });
  assert.equal(r.allowed, true);
  assert.equal(run(mw, ip).passed, false, 'the 2 consumed tickets count against the middleware');
});

test('consume() reservations are visible to a later consume() on the same bucket', () => {
  const key = 'ws:consume-visibility';
  const opts = { name: 'consume-visibility-test', key, max: 5, windowMs: WINDOW };
  assert.equal(consume({ ...opts, n: 3 }).allowed, true);
  assert.equal(consume({ ...opts, n: 3 }).allowed, false, 'only 2 tickets left');
  assert.equal(consume({ ...opts, n: 2 }).allowed, true);
});

test('an unnamed consume() cannot silently drain a named limiter', () => {
  const mw = rateLimit({ name: 'named-only', max: 2, windowMs: WINDOW });
  const ip = '198.51.100.13';
  consume({ key: ip, n: 5, max: 100, windowMs: WINDOW }); // no name
  assert.equal(run(mw, ip).passed, true, 'named limiter is unaffected by the anonymous bucket');
});
