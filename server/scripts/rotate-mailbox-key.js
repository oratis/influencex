#!/usr/bin/env node
/**
 * Rotate the MAILBOX_ENCRYPTION_KEY used for at-rest credential encryption.
 *
 * The script reads every row of `mailbox_accounts.credentials_encrypted`,
 * decrypts it with the OLD key, and re-encrypts with the NEW key.
 * Safe to re-run (idempotent: rows already written with the new key stay put).
 *
 * Usage:
 *
 *   MAILBOX_ENCRYPTION_KEY_OLD=<base64 32-byte> \
 *   MAILBOX_ENCRYPTION_KEY=<base64 32-byte new key> \
 *   node server/scripts/rotate-mailbox-key.js
 *
 *   # Dry-run (inspect counts without writing):
 *   node server/scripts/rotate-mailbox-key.js --dry-run
 *
 * Notes on safety:
 *   - Legacy plaintext JSON rows (written before encryption was enabled)
 *     are migrated to the new key's ciphertext on first run, so this is
 *     also the "bootstrap migration" from plaintext to encrypted storage.
 *   - We decrypt each row independently. Rows that fail to decrypt (wrong
 *     old key, tampered tag) are skipped and summarized — NOT overwritten.
 *   - Run inside a database transaction so a crash mid-rotation leaves the
 *     table in a consistent state.
 */

/* eslint-disable no-console */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const OLD_KEY = process.env.MAILBOX_ENCRYPTION_KEY_OLD || null;
const NEW_KEY = process.env.MAILBOX_ENCRYPTION_KEY || null;

if (!NEW_KEY) {
  console.error('MAILBOX_ENCRYPTION_KEY must be set (the new key).');
  process.exit(1);
}

// Wire up the decryption module with the OLD key while we decrypt,
// then swap in the NEW key to re-encrypt. Since the secrets module caches
// the key on first use, we load it fresh per phase via module.cache deletion.
function freshSecretsWithKey(key) {
  delete require.cache[require.resolve('../secrets')];
  if (key === null) delete process.env.MAILBOX_ENCRYPTION_KEY;
  else process.env.MAILBOX_ENCRYPTION_KEY = key;
  return require('../secrets');
}

async function main() {
  const { query, exec, transaction } = require('../database');

  const rowsRes = await query('SELECT id, credentials_encrypted FROM mailbox_accounts');
  const rows = rowsRes.rows || [];
  console.log(`[rotate] found ${rows.length} mailbox_accounts rows`);

  // Phase 1: decrypt using the OLD key (or fall back to plaintext for legacy rows).
  const withOld = freshSecretsWithKey(OLD_KEY);
  const decrypted = [];
  const skipped = [];
  for (const row of rows) {
    if (!row.credentials_encrypted) {
      skipped.push({ id: row.id, reason: 'empty' });
      continue;
    }
    try {
      const pt = withOld.decrypt(row.credentials_encrypted);
      decrypted.push({ id: row.id, plaintext: pt, isLegacy: !withOld.isEncrypted(row.credentials_encrypted) });
    } catch (e) {
      skipped.push({ id: row.id, reason: `decrypt failed: ${e.message}` });
    }
  }

  console.log(`[rotate] decrypted ${decrypted.length} rows, skipped ${skipped.length}`);
  if (skipped.length) {
    console.log('[rotate] skipped details:');
    for (const s of skipped) console.log(`  - ${s.id}: ${s.reason}`);
  }

  if (DRY_RUN) {
    console.log('[rotate] --dry-run: no writes performed');
    const legacyCount = decrypted.filter(d => d.isLegacy).length;
    console.log(`[rotate] would re-encrypt ${decrypted.length} rows (${legacyCount} legacy plaintext → encrypted, ${decrypted.length - legacyCount} rotated)`);
    process.exit(0);
  }

  // Phase 2: re-encrypt with the NEW key inside a transaction.
  const withNew = freshSecretsWithKey(NEW_KEY);
  let rewritten = 0;
  await transaction(async (tx) => {
    for (const d of decrypted) {
      const blob = withNew.encrypt(d.plaintext);
      await tx.exec(
        'UPDATE mailbox_accounts SET credentials_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [blob, d.id]
      );
      rewritten += 1;
    }
  });

  console.log(`[rotate] rewrote ${rewritten} rows under the new key`);
  console.log('[rotate] done. Make sure MAILBOX_ENCRYPTION_KEY in your running environment matches the new key before restarting the server.');
}

main().catch(e => {
  console.error('[rotate] fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});
