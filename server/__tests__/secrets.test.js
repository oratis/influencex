/**
 * Tests for at-rest credential encryption.
 *
 *   - encrypt → decrypt round-trip preserves the object
 *   - legacy plaintext JSON still decrypts (no-migration compatibility)
 *   - malformed ciphertext errors out instead of silently returning garbage
 *   - IVs are unique (two encrypts of the same value produce different ciphertext)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Set a deterministic key for the test run so results are reproducible.
const KEY = crypto.randomBytes(32).toString('base64');
process.env.MAILBOX_ENCRYPTION_KEY = KEY;

const secrets = require('../secrets');

test('encrypt → decrypt round-trip preserves nested object', () => {
  const payload = { api_key: 're_abc', smtp: { host: 'smtp.x', port: 587 }, scopes: ['a', 'b'] };
  const ct = secrets.encrypt(payload);
  assert.equal(typeof ct, 'string');
  assert.ok(ct.startsWith('aead:v1:'), 'should use our versioned prefix');
  const pt = secrets.decrypt(ct);
  assert.deepEqual(pt, payload);
});

test('encrypt → decrypt round-trip preserves a plain string', () => {
  const ct = secrets.encrypt('hello');
  const pt = secrets.decrypt(ct);
  assert.equal(pt, 'hello');
});

test('legacy plaintext JSON decrypts as-is (no-migration fallback)', () => {
  const legacy = JSON.stringify({ api_key: 'plaintext-legacy' });
  const pt = secrets.decrypt(legacy);
  assert.deepEqual(pt, { api_key: 'plaintext-legacy' });
});

test('legacy non-JSON plaintext is returned as the original string', () => {
  const pt = secrets.decrypt('just-a-string');
  assert.equal(pt, 'just-a-string');
});

test('null and undefined pass through', () => {
  assert.equal(secrets.encrypt(null), null);
  assert.equal(secrets.encrypt(undefined), null);
  assert.equal(secrets.decrypt(null), null);
});

test('two encrypts of the same plaintext produce different ciphertexts (unique IV)', () => {
  const payload = { api_key: 'same' };
  const a = secrets.encrypt(payload);
  const b = secrets.encrypt(payload);
  assert.notEqual(a, b, 'IVs must differ per encryption');
  // Both must still decrypt to the same plaintext.
  assert.deepEqual(secrets.decrypt(a), payload);
  assert.deepEqual(secrets.decrypt(b), payload);
});

test('malformed aead:v1 payload throws on decrypt', () => {
  assert.throws(() => secrets.decrypt('aead:v1:not-enough-parts'), /Malformed AEAD/);
});

test('tampered ciphertext fails authentication', () => {
  const ct = secrets.encrypt({ api_key: 'original' });
  // Flip a byte deep inside the auth tag. Tag is the 4th colon-delimited
  // segment (`aead:v1:<iv>:<tag>:<ct>`). Any mutation to the tag or the
  // ciphertext should fail GCM auth on decrypt.
  const parts = ct.split(':');
  const tag = parts[3];
  const mid = Math.floor(tag.length / 2);
  const flip = tag[mid] === 'A' ? 'B' : 'A';
  parts[3] = tag.slice(0, mid) + flip + tag.slice(mid + 1);
  const tampered = parts.join(':');
  assert.throws(() => secrets.decrypt(tampered));
});

test('isEncrypted detects our format', () => {
  const ct = secrets.encrypt({ a: 1 });
  assert.equal(secrets.isEncrypted(ct), true);
  assert.equal(secrets.isEncrypted('{"a":1}'), false);
  assert.equal(secrets.isEncrypted(null), false);
  assert.equal(secrets.isEncrypted(''), false);
});
