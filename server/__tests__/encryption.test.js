/**
 * Tests for the consolidated crypto module (server/encryption.js) and the
 * platform-connection token helpers that sit on it.
 *
 * Two things are being pinned:
 *
 *   1. There used to be two independent AES-GCM implementations —
 *      encryption.js (`enc:v1:`, base64url) and secrets.js (`aead:v1:`,
 *      standard base64) — both silently deriving a dev key when
 *      MAILBOX_ENCRYPTION_KEY was unset. They are now one module. Rows
 *      written in either format must keep decrypting, forever.
 *
 *   2. platform_connections.access_token / refresh_token were plaintext for
 *      every provider except Gmail, and API-key platforms wrote their
 *      credentials into `metadata` as plaintext JSON (audit S-9). They are
 *      encrypted now, with legacy plaintext rows passing through on read and
 *      getting re-encrypted on the next write.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const KEY = crypto.randomBytes(32).toString('base64');
process.env.MAILBOX_ENCRYPTION_KEY = KEY;

const encryption = require('../encryption');
const publishOauth = require('../publish/oauth');

// ==================== Core round-trip ====================

test('encrypt → decrypt round-trip', () => {
  const secret = 'ya29.a0AfH6SM-super-secret-access-token';
  const ct = encryption.encrypt(secret);
  assert.ok(ct.startsWith('enc:v1:'));
  assert.ok(!ct.includes(secret), 'ciphertext must not contain the plaintext');
  assert.equal(encryption.decrypt(ct), secret);
});

test('round-trip survives unicode and long values', () => {
  const secret = '刷新令牌-🔐-' + 'x'.repeat(5000);
  assert.equal(encryption.decrypt(encryption.encrypt(secret)), secret);
});

test('each encryption uses a fresh IV', () => {
  const a = encryption.encrypt('same');
  const b = encryption.encrypt('same');
  assert.notEqual(a, b);
  assert.equal(encryption.decrypt(a), 'same');
  assert.equal(encryption.decrypt(b), 'same');
});

test('null and undefined pass through untouched', () => {
  assert.equal(encryption.encrypt(null), null);
  assert.equal(encryption.encrypt(undefined), undefined);
  assert.equal(encryption.decrypt(null), null);
  assert.equal(encryption.decrypt(undefined), undefined);
});

test('tampering with the auth tag fails the decrypt', () => {
  const ct = encryption.encrypt('original');
  const parts = ct.split(':');
  const tag = parts[3];
  const mid = Math.floor(tag.length / 2);
  parts[3] = tag.slice(0, mid) + (tag[mid] === 'A' ? 'B' : 'A') + tag.slice(mid + 1);
  assert.throws(() => encryption.decrypt(parts.join(':')));
});

test('a malformed envelope throws rather than returning garbage', () => {
  assert.throws(() => encryption.decrypt('enc:v1:only-one-part'), /Malformed/);
  assert.throws(() => encryption.decrypt('aead:v1:only-one-part'), /Malformed/);
});

// ==================== Legacy formats ====================

test('legacy aead:v1 ciphertext still decrypts', () => {
  // Byte-for-byte what the old secrets.js produced.
  const plaintext = JSON.stringify({ refresh_token: 'legacy-refresh' });
  const key = Buffer.from(KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const legacy = `aead:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;

  assert.equal(encryption.isEncrypted(legacy), true);
  assert.equal(encryption.decrypt(legacy), plaintext);
});

test('plaintext passes through both ways (no-migration legacy rows)', () => {
  assert.equal(encryption.decrypt('ya29.plaintext-legacy-token'), 'ya29.plaintext-legacy-token');
  assert.equal(encryption.decrypt('{"api_key":"plain"}'), '{"api_key":"plain"}');
  assert.equal(encryption.isEncrypted('ya29.plaintext-legacy-token'), false);
});

test('isEncrypted recognises both envelope formats and nothing else', () => {
  assert.equal(encryption.isEncrypted(encryption.encrypt('x')), true);
  assert.equal(encryption.isEncrypted('aead:v1:a:b:c'), true);
  assert.equal(encryption.isEncrypted('plain'), false);
  assert.equal(encryption.isEncrypted(null), false);
  assert.equal(encryption.isEncrypted(42), false);
});

// ==================== Key configuration ====================

test('assertKeyConfigured passes when a valid key is set', () => {
  assert.equal(encryption.assertKeyConfigured(), true);
});

test('assertKeyConfigured rejects a wrong-length key', () => {
  const saved = process.env.MAILBOX_ENCRYPTION_KEY;
  process.env.MAILBOX_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
  try {
    assert.throws(() => encryption.assertKeyConfigured(), /32 bytes/);
  } finally {
    process.env.MAILBOX_ENCRYPTION_KEY = saved;
  }
});

test('production without a key is a hard failure, not a silent dev key', () => {
  const savedKey = process.env.MAILBOX_ENCRYPTION_KEY;
  const savedEnv = process.env.NODE_ENV;
  delete process.env.MAILBOX_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => encryption.assertKeyConfigured(), /MAILBOX_ENCRYPTION_KEY is not set/);
  } finally {
    process.env.MAILBOX_ENCRYPTION_KEY = savedKey;
    process.env.NODE_ENV = savedEnv;
  }
});

test('outside production a missing key is tolerated (dev fallback)', () => {
  const savedKey = process.env.MAILBOX_ENCRYPTION_KEY;
  delete process.env.MAILBOX_ENCRYPTION_KEY;
  try {
    assert.equal(encryption.assertKeyConfigured(), false);
  } finally {
    process.env.MAILBOX_ENCRYPTION_KEY = savedKey;
  }
});

// ==================== Platform connection tokens (S-9) ====================

test('encryptToken/decryptToken round-trip and leave null alone', () => {
  const ct = publishOauth.encryptToken('access-token-123');
  assert.ok(ct.startsWith('enc:v1:'));
  assert.equal(publishOauth.decryptToken(ct), 'access-token-123');
  assert.equal(publishOauth.encryptToken(null), null);
  assert.equal(publishOauth.encryptToken(''), '');
  assert.equal(publishOauth.decryptToken(null), null);
});

test('decryptToken passes a legacy plaintext token straight through', () => {
  // Every non-Gmail provider's rows look like this today.
  assert.equal(publishOauth.decryptToken('plaintext-twitter-token'), 'plaintext-twitter-token');
});

test('decryptToken returns null instead of throwing on an unopenable value', () => {
  // A row encrypted under a rotated-away key must fail that one platform,
  // not take down the whole publish dispatch.
  assert.equal(publishOauth.decryptToken('enc:v1:AAAA:BBBB:CCCC'), null);
});

test('credentialsFromConnection decrypts an OAuth access token', () => {
  const conn = { platform: 'twitter', access_token: publishOauth.encryptToken('tw-secret') };
  assert.equal(publishOauth.credentialsFromConnection(conn), 'tw-secret');
});

test('credentialsFromConnection decrypts + parses api_key metadata', () => {
  const fields = { integration_token: 'ghost-admin-key', site_url: 'https://blog.example' };
  const conn = { platform: 'ghost', metadata: publishOauth.encryptToken(JSON.stringify(fields)) };
  assert.deepEqual(publishOauth.credentialsFromConnection(conn), fields);
});

test('credentialsFromConnection still reads legacy plaintext metadata JSON', () => {
  const fields = { integration_token: 'legacy-plain' };
  const conn = { platform: 'ghost', metadata: JSON.stringify(fields) };
  assert.deepEqual(publishOauth.credentialsFromConnection(conn), fields);
});

test('sanitizeConnection strips every secret from an API response', () => {
  const conn = {
    id: 'conn-1',
    workspace_id: 'ws-1',
    platform: 'ghost',
    account_name: 'blog.example',
    connected_at: '2026-08-01T00:00:00Z',
    expires_at: null,
    access_token: publishOauth.encryptToken('should-never-be-echoed'),
    refresh_token: publishOauth.encryptToken('also-secret'),
    metadata: publishOauth.encryptToken(JSON.stringify({ integration_token: 'secret-key', site_url: 'https://blog.example' })),
  };
  const safe = publishOauth.sanitizeConnection(conn);
  const serialized = JSON.stringify(safe);

  assert.equal('access_token' in safe, false);
  assert.equal('refresh_token' in safe, false);
  assert.equal('metadata' in safe, false);
  assert.ok(!serialized.includes('should-never-be-echoed'));
  assert.ok(!serialized.includes('also-secret'));
  assert.ok(!serialized.includes('secret-key'));
  assert.ok(!serialized.includes('enc:v1:'), 'ciphertext must not be echoed either');

  // ...while keeping what the UI actually renders.
  assert.equal(safe.platform, 'ghost');
  assert.equal(safe.account_name, 'blog.example');
  assert.equal(safe.has_access_token, true);
  assert.equal(safe.has_refresh_token, true);
  assert.deepEqual(safe.metadata_fields.sort(), ['integration_token', 'site_url']);
  assert.equal(safe.site_url, 'https://blog.example');
});

test('sanitizeConnection also strips secrets from a legacy plaintext row', () => {
  const conn = {
    platform: 'twitter',
    account_name: '@brand',
    access_token: 'plaintext-legacy-token',
    refresh_token: null,
    metadata: '{}',
  };
  const safe = publishOauth.sanitizeConnection(conn);
  assert.ok(!JSON.stringify(safe).includes('plaintext-legacy-token'));
  assert.equal(safe.has_access_token, true);
  assert.equal(safe.has_refresh_token, false);
});
