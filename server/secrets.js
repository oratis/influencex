/**
 * At-rest encryption for credential *objects* — mailbox API keys, SMTP
 * passwords, OAuth refresh tokens.
 *
 * This is a thin JSON facade over `server/encryption.js`, which owns the one
 * AES-256-GCM implementation in the codebase. It used to be a second,
 * independent implementation with its own `aead:v1:` wire format; two crypto
 * modules with two wire formats is one more than anyone can keep correct, so
 * the primitives were consolidated. What survives here is only the
 * object-vs-string convenience its callers depend on:
 *
 *   encrypt({ api_key: '…' })  → 'enc:v1:…'      (JSON.stringify first)
 *   decrypt('enc:v1:…')        → { api_key: '…' } (JSON.parse after)
 *
 * Reads still accept all three historical shapes:
 *   - `enc:v1:`  — what we write now
 *   - `aead:v1:` — written by the old implementation, decrypted forever
 *   - bare JSON  — plaintext rows from before encryption existed
 *
 * Threat model is unchanged: this defends against a database dump being
 * readable by someone who has the dump but not MAILBOX_ENCRYPTION_KEY. It is
 * not an HSM/KMS. Key rotation means re-encrypting every row — see
 * server/scripts/rotate-mailbox-key.js.
 */

const encryption = require('./encryption');

/**
 * Encrypt a JSON-serializable credential object (or a plain string).
 * Returns the serialized ciphertext ready to store, or null for null input.
 */
function encrypt(plaintextObj) {
  if (plaintextObj == null) return null;
  const json = typeof plaintextObj === 'string' ? plaintextObj : JSON.stringify(plaintextObj);
  return encryption.encrypt(json);
}

/**
 * Decrypt and parse. Accepts both ciphertext formats and legacy plaintext
 * JSON, so no migration is needed to read old rows. Non-JSON plaintext comes
 * back as the original string.
 */
function decrypt(stored) {
  if (stored == null) return null;
  if (typeof stored === 'object') return stored; // already parsed
  const plain = encryption.decrypt(stored);
  if (typeof plain !== 'string') return plain;
  try { return JSON.parse(plain); } catch { return plain; }
}

/**
 * True if the stored value is ciphertext (either format) rather than a
 * legacy plaintext row.
 */
function isEncrypted(stored) {
  return encryption.isEncrypted(stored);
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  resetKeyCache: encryption.resetKeyCache,
};
