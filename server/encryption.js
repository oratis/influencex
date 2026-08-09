/**
 * The single AES-256-GCM implementation for secrets stored in the database.
 *
 * This module used to have a twin: `server/secrets.js` carried a second,
 * independent AES-GCM implementation with its own `aead:v1:` wire format,
 * its own base64 flavour and its own dev-key derivation. Two crypto modules
 * meant two places to get padding, IV reuse or key handling wrong, and
 * values written by one were undecryptable by the other. They are now one:
 * `secrets.js` is a thin object/JSON facade over the primitives here, and
 * everything new is written in the `enc:v1:` format.
 *
 * Wire formats (decrypt handles both; encrypt only ever emits the first):
 *
 *   enc:v1:<base64url(iv)>:<base64url(tag)>:<base64url(ciphertext)>
 *   aead:v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>   ← legacy, read-only
 *
 * Anything without a known prefix is returned unchanged. That passthrough is
 * what lets rows written before encryption landed (plaintext OAuth tokens,
 * plaintext credential JSON) keep working; they get re-encrypted on their
 * next write.
 *
 * Key: MAILBOX_ENCRYPTION_KEY, 32 bytes base64 (`openssl rand -base64 32`).
 *
 * Missing key:
 *   - production  → hard failure. Deriving a key from a constant would mean
 *     "encrypted" columns anyone with the source can read, which is worse
 *     than plaintext because it looks safe. Call assertKeyConfigured() at
 *     boot so this surfaces as a failed deploy, not a 500 on first use.
 *   - dev / test  → derive a throwaway key and warn loudly on every process.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const LEGACY_PREFIX = 'aead:v1:';

let cachedKey = null;
let cachedLegacyDevKey = null;
let warnedDev = false;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function parseEnvKey(raw) {
  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch { buf = Buffer.alloc(0); }
  if (buf.length !== 32) {
    throw new Error('MAILBOX_ENCRYPTION_KEY must decode to exactly 32 bytes (generate with `openssl rand -base64 32`).');
  }
  return buf;
}

/**
 * Boot-time gate. index.js calls this before listen() so a production
 * deployment without a key dies immediately and visibly.
 */
function assertKeyConfigured() {
  if (process.env.MAILBOX_ENCRYPTION_KEY) {
    parseEnvKey(process.env.MAILBOX_ENCRYPTION_KEY); // validate length now
    return true;
  }
  if (isProduction()) {
    throw new Error(
      'MAILBOX_ENCRYPTION_KEY is not set. Mailbox credentials and platform OAuth tokens ' +
      'cannot be encrypted at rest without it. Generate one with `openssl rand -base64 32` ' +
      'and set it via Secret Manager before deploying.'
    );
  }
  return false;
}

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.MAILBOX_ENCRYPTION_KEY;
  if (raw) {
    cachedKey = parseEnvKey(raw);
    return cachedKey;
  }
  // No key. In production this is fatal — see assertKeyConfigured(); we
  // repeat the check here because a lazily-loaded code path could otherwise
  // reach encrypt() without the boot gate having run (tests, scripts).
  if (isProduction()) {
    throw new Error('MAILBOX_ENCRYPTION_KEY is not set — refusing to encrypt with a derived key in production.');
  }
  if (!warnedDev) {
    // Deliberately console.warn and not the logger: this must be visible even
    // when LOG_LEVEL filters everything else out.
    console.warn(
      '\n' +
      '*********************************************************************\n' +
      '  [encryption] MAILBOX_ENCRYPTION_KEY is NOT SET.\n' +
      '  Falling back to a key derived from a constant — every install\n' +
      '  derives the same one, so stored credentials are effectively\n' +
      '  PLAINTEXT to anyone with this source tree.\n' +
      '  Fine for local dev. NEVER deploy like this.\n' +
      '  Generate one: openssl rand -base64 32\n' +
      '*********************************************************************\n'
    );
    warnedDev = true;
  }
  cachedKey = crypto.createHash('sha256').update('influencex-dev-only-derived-key').digest();
  return cachedKey;
}

/**
 * The dev key the old secrets.js derived, kept solely so `aead:v1:` values a
 * developer already has on disk still decrypt. Hostname-seeded, exactly as
 * before. Never used when MAILBOX_ENCRYPTION_KEY is set.
 */
function loadLegacyDevKey() {
  if (cachedLegacyDevKey) return cachedLegacyDevKey;
  const seed = `influencex-dev-${require('os').hostname()}-mailbox-v1`;
  cachedLegacyDevKey = crypto.createHash('sha256').update(seed).digest();
  return cachedLegacyDevKey;
}

/**
 * Drop the memoized key. Only for the key-rotation script and tests, which
 * change MAILBOX_ENCRYPTION_KEY inside a live process.
 */
function resetKeyCache() {
  cachedKey = null;
  cachedLegacyDevKey = null;
  warnedDev = false;
}

function b64u(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(LEGACY_PREFIX));
}

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  const key = loadKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, the GCM recommendation
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

function openSealed(payload, decodeB64, key) {
  const [ivB64, tagB64, ctB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, decodeB64(ivB64));
  decipher.setAuthTag(decodeB64(tagB64));
  return Buffer.concat([decipher.update(decodeB64(ctB64)), decipher.final()]).toString('utf8');
}

function decrypt(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;

  if (value.startsWith(PREFIX)) {
    return openSealed(value.slice(PREFIX.length), fromB64u, loadKey());
  }

  if (value.startsWith(LEGACY_PREFIX)) {
    // Legacy secrets.js format: standard base64, and — when no env key is
    // configured — a hostname-derived dev key rather than the constant one.
    const payload = value.slice(LEGACY_PREFIX.length);
    if (payload.split(':').length !== 3) throw new Error('Malformed AEAD payload');
    const decodeB64 = (s) => Buffer.from(s, 'base64');
    const key = process.env.MAILBOX_ENCRYPTION_KEY ? loadKey() : loadLegacyDevKey();
    return openSealed(payload, decodeB64, key);
  }

  return value; // plaintext legacy row — pass through
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  assertKeyConfigured,
  resetKeyCache,
  PREFIX,
  LEGACY_PREFIX,
};
