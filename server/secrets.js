/**
 * At-rest encryption for sensitive credentials (mailbox API keys, SMTP
 * passwords, OAuth refresh tokens).
 *
 * We use AES-256-GCM with a random IV per record. The ciphertext payload is
 * serialized as `aead:v1:<iv_b64>:<tag_b64>:<ct_b64>` so readers can
 * detect the format and fall back to plaintext JSON for legacy rows.
 *
 * Key source — env var MAILBOX_ENCRYPTION_KEY, base64-encoded 32 bytes.
 * In dev, if unset, we derive a stable throwaway key from the machine's
 * workspace so the app runs — but we warn loudly, because reading those
 * rows from a new machine will fail.
 *
 * This is *not* a full HSM / KMS setup. Threat model: defends against
 * database dumps being readable by a casual attacker with the db file but
 * not the key. Rotating the key requires re-encrypting all rows.
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'aead:v1:';

let cachedKey = null;
let warnedDev = false;

function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.MAILBOX_ENCRYPTION_KEY;
  if (envKey) {
    let raw;
    try { raw = Buffer.from(envKey, 'base64'); } catch { raw = Buffer.alloc(0); }
    if (raw.length !== 32) {
      throw new Error('MAILBOX_ENCRYPTION_KEY must be 32 bytes base64-encoded (44 chars). Generate one with `openssl rand -base64 32`.');
    }
    cachedKey = raw;
    return cachedKey;
  }
  // Dev fallback — deterministic from the machine hostname so restarts don't
  // break decryption, but not portable across machines. Loud warning so ops
  // don't deploy like this.
  if (!warnedDev) {
    console.warn('[secrets] MAILBOX_ENCRYPTION_KEY not set — using a dev-only derived key. DO NOT use in production; rows will not decrypt on a different host.');
    warnedDev = true;
  }
  const seed = `influencex-dev-${require('os').hostname()}-mailbox-v1`;
  cachedKey = crypto.createHash('sha256').update(seed).digest();
  return cachedKey;
}

/**
 * Encrypt a JSON-serializable credential object. Returns the serialized
 * `aead:v1:...` string ready to store.
 */
function encrypt(plaintextObj) {
  if (plaintextObj == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM recommends 96-bit IV
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const json = typeof plaintextObj === 'string' ? plaintextObj : JSON.stringify(plaintextObj);
  const ct = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt. Accepts both our aead:v1 format and legacy plaintext JSON (so we
 * don't need a migration to flip old rows). Returns the parsed object.
 */
function decrypt(stored) {
  if (stored == null) return null;
  if (typeof stored === 'object') return stored; // already parsed
  if (!stored.startsWith(PREFIX)) {
    // Legacy plaintext JSON — try to parse. If it's not JSON, return the string as-is.
    try { return JSON.parse(stored); } catch { return stored; }
  }
  const rest = stored.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) throw new Error('Malformed AEAD payload');
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  const json = pt.toString('utf8');
  try { return JSON.parse(json); } catch { return json; }
}

/**
 * True if the stored value is already encrypted in our format.
 */
function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
