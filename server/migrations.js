/**
 * Simple forward-only migration framework.
 *
 * Migrations are versioned SQL transformations tracked in a `schema_migrations`
 * table. Each migration has a unique string id (typically a timestamp + name)
 * and an up() function that runs SQL. Down-migrations are not supported —
 * this is intentional to keep ops simple for a small team.
 *
 * To add a migration: push a new entry to MIGRATIONS below. The server will
 * auto-run pending migrations on startup.
 */

const MIGRATIONS = [
  // Example seed — future migrations follow this pattern.
  // {
  //   id: '2026-05-01-add-kol-notes',
  //   description: 'Add notes column to kols table',
  //   up: async ({ exec }) => {
  //     await exec('ALTER TABLE kols ADD COLUMN notes TEXT');
  //   },
  // },
];

async function ensureMigrationsTable({ query, exec }) {
  // Works on both Postgres and SQLite
  await exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations({ query }) {
  const result = await query('SELECT id FROM schema_migrations');
  return new Set((result.rows || []).map(r => r.id));
}

async function runPendingMigrations(dbApi) {
  await ensureMigrationsTable(dbApi);
  const applied = await getAppliedMigrations(dbApi);

  const pending = MIGRATIONS.filter(m => !applied.has(m.id));
  if (pending.length === 0) {
    return { applied: 0, total: applied.size };
  }

  console.log(`[migrations] Running ${pending.length} pending migration(s)...`);
  for (const migration of pending) {
    const start = Date.now();
    try {
      await migration.up(dbApi);
      await dbApi.exec(
        'INSERT INTO schema_migrations (id, description) VALUES (?, ?)',
        [migration.id, migration.description || '']
      );
      console.log(`[migrations] ✓ ${migration.id} (${Date.now() - start}ms)`);
    } catch (e) {
      console.error(`[migrations] ✗ ${migration.id} failed:`, e.message);
      throw new Error(`Migration ${migration.id} failed: ${e.message}`);
    }
  }

  return { applied: pending.length, total: applied.size + pending.length };
}

module.exports = { runPendingMigrations, MIGRATIONS };
