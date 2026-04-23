/**
 * Symmetric encryption helper for secrets stored in the database.
 *
 * Format: `enc:v1:<base64url(iv)>:<base64url(tag)>:<base64url(ciphertext)>`
 * Cipher: AES-256-GCM. Key is a 32-byte secret supplied via
 * MAILBOX_ENCRYPTION_KEY (base64-encoded — generate with
 * `openssl rand -base64 32`).
 *
 * The `enc:v1:` prefix lets readers detect whether a stored value is
 * already encrypted, which matters during the rollout: legacy rows
 * written before encryption landed (e.g. existing YouTube/TikTok
 * tokens) stay readable as plaintext, and only new Gmail tokens get
 * encrypted. A future migration can re-encrypt legacy rows by running
 * them through `encrypt()` and writing back.
 *
 * Dev fallback: if MAILBOX_ENCRYPTION_KEY is unset we derive a 32-byte
 * key from a fixed string and log a loud warning. This keeps `npm run
 * dev` working out of the box but is not acceptable for multi-host
 * deployments — each process would derive the same key, but any key
 * rotation is impossible and the warning makes that obvious.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let cachedKey = null;
let warnedDev = false;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.MAILBOX_ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('MAILBOX_ENCRYPTION_KEY must decode to exactly 32 bytes (generate with `openssl rand -base64 32`).');
    }
    cachedKey = buf;
    return cachedKey;
  }
  if (!warnedDev) {
    console.warn('[encryption] MAILBOX_ENCRYPTION_KEY not set — using dev-only derived key. Do NOT deploy like this.');
    warnedDev = true;
  }
  cachedKey = crypto.createHash('sha256').update('influencex-dev-only-derived-key').digest();
  return cachedKey;
}

function b64u(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

function decrypt(value) {
  if (value == null) return value;
  if (!isEncrypted(value)) return value; // plaintext legacy row — pass through
  const rest = value.slice(PREFIX.length);
  const [ivB64, tagB64, ctB64] = rest.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(ivB64));
  decipher.setAuthTag(fromB64u(tagB64));
  const pt = Buffer.concat([decipher.update(fromB64u(ctB64)), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
