/**
 * Inbound webhook signature verification (Resend/Svix + Apify).
 *
 * Extracted from index.js so the fail-open/fail-closed policy is unit
 * testable. Policy when the corresponding secret env is NOT configured:
 *   - production: reject (fail-closed) — an unsigned webhook endpoint would
 *     let anyone forge email events / actor-run updates.
 *   - dev/test: allow (fail-open) so local webhook testing works without
 *     provisioning real secrets.
 */

const crypto = require('crypto');
const { Buffer } = require('buffer');
const log = require('./logger');

function allowUnsigned(secretName) {
  if (process.env.NODE_ENV === 'production') {
    log.error(`[webhook] ${secretName} is not set — rejecting webhook (fail-closed in production)`);
    return false;
  }
  return true;
}

/**
 * Resend uses Svix webhooks: secret is base64-encoded after "whsec_" prefix,
 * signature is HMAC-SHA256 over `${msgId}.${timestamp}.${rawBody}`.
 */
function verifyResendSignature(req, secret = process.env.RESEND_WEBHOOK_SECRET || '') {
  if (!secret) return allowUnsigned('RESEND_WEBHOOK_SECRET');
  const signature = req.headers['resend-signature'] || req.headers['svix-signature'] || '';
  const timestamp = req.headers['svix-timestamp'] || '';
  const msgId = req.headers['svix-id'] || '';
  if (!signature || !timestamp) return false;

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const toSign = `${msgId}.${timestamp}.${rawBody}`;
  const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const expectedSig = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');

  // Signature header may contain multiple sigs: "v1,<base64>"
  const sigs = signature.split(' ').map(s => s.replace('v1,', ''));
  return sigs.some(s => s === expectedSig);
}

/**
 * Apify: hex HMAC-SHA256 of the raw body with the shared secret.
 */
function verifyApifySignature(req, secret = process.env.APIFY_WEBHOOK_SECRET || '') {
  if (!secret) return allowUnsigned('APIFY_WEBHOOK_SECRET');
  const provided = req.headers['x-apify-webhook-signature'] || req.headers['apify-webhook-signature'] || '';
  if (!provided) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time compare. Apify's signature is hex.
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { verifyResendSignature, verifyApifySignature };
