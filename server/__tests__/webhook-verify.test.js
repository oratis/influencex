/**
 * Tests for server/webhook-verify.js — Resend (Svix) + Apify webhook
 * signature verification, extracted from index.js.
 *
 * Key regression: with no secret configured the old inline checks returned
 * true (fail-open), so production accepted forged webhooks. Now: production
 * rejects (fail-closed), dev/test stays permissive.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyResendSignature, verifyApifySignature } = require('../webhook-verify');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  if (ORIGINAL_ENV.RESEND_WEBHOOK_SECRET === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = ORIGINAL_ENV.RESEND_WEBHOOK_SECRET;
  if (ORIGINAL_ENV.APIFY_WEBHOOK_SECRET === undefined) delete process.env.APIFY_WEBHOOK_SECRET;
  else process.env.APIFY_WEBHOOK_SECRET = ORIGINAL_ENV.APIFY_WEBHOOK_SECRET;
});

function makeReq({ headers = {}, body = {} } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { headers, body, rawBody };
}

// ==================== fail-open / fail-closed policy ====================

test('unset secret + production → reject (fail-closed)', () => {
  process.env.NODE_ENV = 'production';
  assert.equal(verifyResendSignature(makeReq(), ''), false);
  assert.equal(verifyApifySignature(makeReq(), ''), false);
});

test('unset secret via env + production → reject (fail-closed)', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.APIFY_WEBHOOK_SECRET;
  assert.equal(verifyResendSignature(makeReq()), false);
  assert.equal(verifyApifySignature(makeReq()), false);
});

test('unset secret outside production → allow (local dev stays permissive)', () => {
  process.env.NODE_ENV = 'development';
  assert.equal(verifyResendSignature(makeReq(), ''), true);
  assert.equal(verifyApifySignature(makeReq(), ''), true);
});

// ==================== Resend (Svix) signatures ====================

function signResend(secret, msgId, timestamp, rawBody) {
  const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64');
  return crypto.createHmac('sha256', secretBytes)
    .update(`${msgId}.${timestamp}.${rawBody}`)
    .digest('base64');
}

test('valid Resend signature verifies', () => {
  process.env.NODE_ENV = 'production';
  const secret = 'whsec_' + Buffer.from('resend-test-secret').toString('base64');
  const body = { type: 'email.delivered', data: { email_id: 'abc' } };
  const req = makeReq({ body });
  const msgId = 'msg_1', ts = '1700000000';
  const sig = signResend(secret, msgId, ts, req.rawBody);
  req.headers = { 'svix-id': msgId, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
  assert.equal(verifyResendSignature(req, secret), true);
});

test('tampered Resend body is rejected', () => {
  process.env.NODE_ENV = 'production';
  const secret = 'whsec_' + Buffer.from('resend-test-secret').toString('base64');
  const req = makeReq({ body: { type: 'email.delivered' } });
  const msgId = 'msg_1', ts = '1700000000';
  const sig = signResend(secret, msgId, ts, req.rawBody);
  req.headers = { 'svix-id': msgId, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
  req.rawBody = Buffer.from(JSON.stringify({ type: 'email.bounced' })); // tamper
  assert.equal(verifyResendSignature(req, secret), false);
});

test('missing Resend signature headers are rejected when secret is set', () => {
  process.env.NODE_ENV = 'development'; // even outside prod, a configured secret must be enforced
  const secret = 'whsec_' + Buffer.from('resend-test-secret').toString('base64');
  assert.equal(verifyResendSignature(makeReq(), secret), false);
});

// ==================== Apify signatures ====================

test('valid Apify signature verifies; wrong one is rejected', () => {
  process.env.NODE_ENV = 'production';
  const secret = 'apify-shared-secret';
  const body = { eventType: 'ACTOR.RUN.SUCCEEDED', resource: { id: 'run1' } };
  const req = makeReq({ body });
  const good = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

  req.headers = { 'x-apify-webhook-signature': good };
  assert.equal(verifyApifySignature(req, secret), true);

  req.headers = { 'x-apify-webhook-signature': good.replace(/^./, good[0] === 'a' ? 'b' : 'a') };
  assert.equal(verifyApifySignature(req, secret), false);

  req.headers = {};
  assert.equal(verifyApifySignature(req, secret), false);

  req.headers = { 'x-apify-webhook-signature': 'not-hex!!' };
  assert.equal(verifyApifySignature(req, secret), false);
});
