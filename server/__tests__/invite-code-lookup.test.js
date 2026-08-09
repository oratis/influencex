/**
 * Rate limiting for the public invite-code lookup.
 *
 * GET /api/invite-codes/lookup/:code is unauthenticated and answers "does
 * this code exist". Codes are INFLX- plus 8 characters of a 31-symbol
 * alphabet (~40 bits), which is fine against a human but not against an
 * unlimited endpoint at a few thousand requests per second.
 *
 * The wiring (limiter attached to the route, own bucket key) is asserted in
 * rbac-routes.test.js. This file pins the limiter's behaviour at the numbers
 * the route configures.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module per test file so the shared bucket map starts empty.
delete require.cache[require.resolve('../rate-limit')];
const { rateLimit } = require('../rate-limit');

const MAX = 20;
const WINDOW_MS = 60 * 1000;

function makeLimiter() {
  return rateLimit({
    max: MAX,
    windowMs: WINDOW_MS,
    keyFn: (req) => `invite-lookup-test:${req.ip}`,
    message: 'Too many invite code lookups, please slow down',
  });
}

function run(limiter, ip) {
  const req = { ip, headers: {} };
  const out = { status: 200, body: null, headers: {} };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    set(k, v) { out.headers[k] = v; return this; },
  };
  let passed = false;
  limiter(req, res, () => { passed = true; });
  return { ...out, passed };
}

test('allows requests up to the cap, then blocks', () => {
  const limiter = makeLimiter();
  const ip = '203.0.113.10';
  for (let i = 0; i < MAX; i++) {
    const r = run(limiter, ip);
    assert.equal(r.passed, true, `request ${i + 1} should pass`);
  }
  const blocked = run(limiter, ip);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'RATE_LIMITED');
});

test('a blocked response carries Retry-After so clients back off', () => {
  const limiter = makeLimiter();
  const ip = '203.0.113.11';
  for (let i = 0; i < MAX; i++) run(limiter, ip);
  const blocked = run(limiter, ip);
  assert.ok(blocked.headers['Retry-After'], 'Retry-After header expected');
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.ok(blocked.body.retryAfter > 0);
});

test('the cap makes an exhaustive sweep of the keyspace infeasible', () => {
  // INFLX- + 8 chars from a 31-symbol alphabet.
  const keyspace = Math.pow(31, 8); // ~8.5e11
  const perYearPerIp = MAX * 60 * 24 * 365; // ~1.05e7
  const yearsToSweep = keyspace / perYearPerIp;
  // ~81,000 years per IP at 20/min. Even 1,000 hosts leaves it out of reach,
  // and the point is that the number is astronomically larger than the
  // "minutes" an ungated endpoint offered.
  assert.ok(yearsToSweep > 10_000, `single-IP sweep takes only ${Math.round(yearsToSweep)} years`);
});

test('separate IPs get separate budgets', () => {
  const limiter = makeLimiter();
  for (let i = 0; i < MAX; i++) run(limiter, '203.0.113.12');
  assert.equal(run(limiter, '203.0.113.12').passed, false);
  assert.equal(run(limiter, '203.0.113.13').passed, true, 'a different client must not inherit the block');
});

test('exhausting the invite lookup budget does not lock the same IP out of login', () => {
  // Both limiters use the DEFAULT keyFn here on purpose: rate-limit.js gives
  // every instance its own namespace, so 20 signup-page lookups must not eat
  // the 10/min login budget for that IP. (Before that fix they shared one
  // window and this scenario locked the user out.)
  const inviteLimiter = rateLimit({ max: MAX, windowMs: WINDOW_MS });
  const authLimiter = rateLimit({ max: 10, windowMs: WINDOW_MS });
  const ip = '203.0.113.20';
  for (let i = 0; i < MAX; i++) run(inviteLimiter, ip);
  assert.equal(run(inviteLimiter, ip).passed, false, 'invite bucket is exhausted');
  assert.equal(run(authLimiter, ip).passed, true, 'login must still be possible');
});
