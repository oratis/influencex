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

const { v4: uuidv4 } = require('uuid');

// Tables that need a workspace_id column added in the multi-tenancy migration.
// New tables created in v2 (agents, content_pieces, etc) declare workspace_id
// in their CREATE TABLE directly; this list covers the 13 pre-existing tables.
const MULTITENANT_TABLES = [
  'campaigns', 'kols', 'contacts', 'pipeline_jobs', 'kol_database',
  'content_data', 'registration_data', 'content_scrape_cache',
  'content_daily_stats', 'dashboard_events', 'discovery_jobs',
  'discovery_results', 'email_replies',
];

async function addWorkspaceIdColumn(exec, table) {
  try {
    await exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
  } catch (e) {
    // Idempotent: column may already exist on re-run
    if (!/duplicate|already exists/i.test(e.message)) throw e;
  }
}

async function ensureWorkspaceIndex(exec, table) {
  try {
    await exec(`CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id)`);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }
}

const MIGRATIONS = [
  {
    id: '2026-04-18-scheduler-fields',
    description: 'Add scheduled_send_at and follow_up_count to contacts',
    up: async ({ exec }) => {
      for (const stmt of [
        'ALTER TABLE contacts ADD COLUMN scheduled_send_at TIMESTAMP',
        'ALTER TABLE contacts ADD COLUMN follow_up_count INTEGER DEFAULT 0',
      ]) {
        try { await exec(stmt); } catch (e) {
          if (!/duplicate|already exists/i.test(e.message)) throw e;
        }
      }
    },
  },

  {
    id: '2026-04-18-multitenancy-init',
    description: 'Add workspace_id to 13 business tables; backfill existing data into owner workspaces',
    up: async ({ exec, query, queryOne }) => {
      // 1. Add workspace_id column + index on each business table.
      //    workspaces & workspace_members tables are created by the base schema
      //    in database.js — no-op here.
      for (const table of MULTITENANT_TABLES) {
        await addWorkspaceIdColumn(exec, table);
        await ensureWorkspaceIndex(exec, table);
      }

      // 2. Backfill: create one workspace per existing user.
      //    Using workspace_members as the "has this user been migrated" marker
      //    so this block is idempotent.
      const usersResult = await query('SELECT id, name, email FROM users ORDER BY created_at ASC');
      const users = usersResult.rows || [];
      const userWorkspaces = new Map(); // user_id -> workspace_id

      for (const u of users) {
        const existing = await queryOne(
          'SELECT workspace_id FROM workspace_members WHERE user_id = ?',
          [u.id]
        );
        if (existing) {
          userWorkspaces.set(u.id, existing.workspace_id);
          continue;
        }

        const wsId = uuidv4();
        const slug = slugify(u.name || u.email.split('@')[0], wsId);
        const name = (u.name ? `${u.name}'s workspace` : u.email);

        await exec(
          'INSERT INTO workspaces (id, name, slug, owner_user_id, plan) VALUES (?, ?, ?, ?, ?)',
          [wsId, name, slug, u.id, 'starter']
        );
        await exec(
          'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
          [wsId, u.id, 'admin']
        );
        userWorkspaces.set(u.id, wsId);
      }

      // 3. Lazily determine a target workspace for orphan data when we hit it.
      //    Policy:
      //      - 1 user: orphans go to that user's workspace (no Legacy sidecar)
      //      - >1 users: create a shared "Legacy" workspace (only if needed)
      //        owned by the first admin, with all users as members so none
      //        lose access to their old data
      //      - 0 users: skip (there's no owner; rows stay orphaned)
      let cachedFallbackWsId = null;
      async function resolveFallbackWorkspace() {
        if (cachedFallbackWsId !== null) return cachedFallbackWsId;
        if (users.length === 0) {
          cachedFallbackWsId = false; // sentinel: no fallback possible
          return null;
        }
        if (users.length === 1) {
          cachedFallbackWsId = userWorkspaces.get(users[0].id);
          return cachedFallbackWsId;
        }
        // >1 users: find or create Legacy workspace
        const existing = await queryOne("SELECT id FROM workspaces WHERE slug = 'legacy'");
        if (existing) {
          cachedFallbackWsId = existing.id;
          return cachedFallbackWsId;
        }
        const firstAdmin = users.find(u => u.role === 'admin') || users[0];
        const newId = uuidv4();
        await exec(
          'INSERT INTO workspaces (id, name, slug, owner_user_id, plan) VALUES (?, ?, ?, ?, ?)',
          [newId, 'Legacy data', 'legacy', firstAdmin.id, 'starter']
        );
        for (const u of users) {
          await exec(
            'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
            [newId, u.id, u.id === firstAdmin.id ? 'admin' : 'editor']
          );
        }
        cachedFallbackWsId = newId;
        return newId;
      }

      for (const table of MULTITENANT_TABLES) {
        const orphan = await queryOne(
          `SELECT COUNT(*) as c FROM ${table} WHERE workspace_id IS NULL`
        );
        const count = parseInt(orphan?.c || 0);
        if (count === 0) continue;

        // For tables that reference campaigns, inherit workspace_id from
        // the parent campaign if available (keeps things tidy).
        const hasCampaignFk = ['kols', 'contacts', 'pipeline_jobs'].includes(table);
        if (hasCampaignFk) {
          await exec(
            `UPDATE ${table} SET workspace_id = (
              SELECT workspace_id FROM campaigns WHERE campaigns.id = ${table}.campaign_id
            ) WHERE workspace_id IS NULL AND campaign_id IS NOT NULL`
          );
        }

        // Anything still orphaned goes to the fallback workspace (user's own
        // for single-user installs, or Legacy for multi-user installs).
        const stillOrphan = await queryOne(
          `SELECT COUNT(*) as c FROM ${table} WHERE workspace_id IS NULL`
        );
        if (parseInt(stillOrphan?.c || 0) > 0) {
          const wsId = await resolveFallbackWorkspace();
          if (wsId) {
            await exec(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`, [wsId]);
          }
        }
      }

      // 4. Summary (for logs)
      const totalWs = await queryOne('SELECT COUNT(*) as c FROM workspaces');
      console.log(`[migration] multitenancy-init complete: ${totalWs?.c || 0} workspaces total`);
    },
  },
];

// Slugify helper — lowercase, replace non-alphanumeric with dashes,
// suffix with short UUID fragment for uniqueness.
function slugify(name, uuid) {
  const base = (name || 'workspace')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    || 'workspace';
  const suffix = (uuid || '').replace(/-/g, '').slice(0, 6);
  return suffix ? `${base}-${suffix}` : base;
}

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
