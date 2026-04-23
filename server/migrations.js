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
    id: '2026-04-19-prompts-schedules-oauth',
    description: 'Prompt presets, scheduled publishes, platform OAuth connections',
    up: async ({ exec }) => {
      const stmts = [
        `CREATE TABLE IF NOT EXISTS prompt_presets (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          prompt TEXT NOT NULL,
          type TEXT NOT NULL,
          agent_id TEXT,
          tags TEXT DEFAULT '[]',
          use_count INTEGER DEFAULT 0,
          created_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_prompt_presets_workspace ON prompt_presets(workspace_id)`,
        `CREATE INDEX IF NOT EXISTS idx_prompt_presets_type ON prompt_presets(type)`,

        `CREATE TABLE IF NOT EXISTS scheduled_publishes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          content_piece_id TEXT,
          platforms TEXT NOT NULL,
          content_snapshot TEXT NOT NULL,
          scheduled_at TIMESTAMP NOT NULL,
          status TEXT DEFAULT 'pending',
          result TEXT,
          mode TEXT DEFAULT 'intent',
          attempts INTEGER DEFAULT 0,
          created_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_attempt_at TIMESTAMP,
          completed_at TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_sched_pub_workspace ON scheduled_publishes(workspace_id)`,
        `CREATE INDEX IF NOT EXISTS idx_sched_pub_due ON scheduled_publishes(status, scheduled_at)`,

        `CREATE TABLE IF NOT EXISTS platform_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          account_name TEXT,
          account_id TEXT,
          access_token TEXT,
          refresh_token TEXT,
          token_scope TEXT,
          expires_at TIMESTAMP,
          metadata TEXT DEFAULT '{}',
          connected_by TEXT,
          connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_used_at TIMESTAMP,
          UNIQUE(workspace_id, platform)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_platform_conn_workspace ON platform_connections(workspace_id)`,

        `CREATE TABLE IF NOT EXISTS oauth_states (
          state TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          code_verifier TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS competitor_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          competitor_name TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          text_digest TEXT,
          content_hash TEXT,
          metadata TEXT DEFAULT '{}',
          captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_comp_snap_workspace ON competitor_snapshots(workspace_id)`,
        `CREATE INDEX IF NOT EXISTS idx_comp_snap_url ON competitor_snapshots(url)`,
      ];
      for (const s of stmts) {
        try { await exec(s); } catch (e) {
          if (!/already exists/i.test(e.message)) throw e;
        }
      }
    },
  },

  {
    id: '2026-04-19-sso-billing-blog',
    description: 'Google SSO sub on users, subscriptions + plans for Stripe billing, blog-platform connection extensions',
    up: async ({ exec }) => {
      // Google SSO — add a nullable `google_sub` column so we can link
      // an OAuth identity to an existing email-password user or bootstrap
      // a new user without a password.
      const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '');
      const stmts = [
        'ALTER TABLE users ADD COLUMN google_sub TEXT',
        'ALTER TABLE users ADD COLUMN google_picture TEXT',
      ];
      // Postgres enforces NOT NULL; SQLite has no ALTER COLUMN syntax at all,
      // and columns added later are nullable by default — so we only issue
      // DROP NOT NULL on Postgres.
      if (isPostgres) {
        stmts.push('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL');
      }
      for (const stmt of stmts) {
        try { await exec(stmt); } catch (e) {
          if (!/duplicate|already exists|does not exist|not null constraint/i.test(e.message)) throw e;
        }
      }
      try { await exec('CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)'); } catch {}

      // Stripe billing — subscriptions scoped to workspace. A workspace has
      // at most one active subscription; historical rows are kept for audit.
      try {
        await exec(`CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          stripe_price_id TEXT,
          plan TEXT DEFAULT 'free',
          status TEXT DEFAULT 'active',
          current_period_end TIMESTAMP,
          seats INTEGER DEFAULT 1,
          metadata TEXT DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
      try { await exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON subscriptions(workspace_id)'); } catch {}
      try { await exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id)'); } catch {}
    },
  },

  {
    id: '2026-04-19-agent-runtime-tables',
    description: 'Create agents, agent_runs, agent_traces, content_pieces, brand_voices tables for Phase A Week 2',
    up: async ({ exec }) => {
      // agents table: static metadata about registered agents. Populated
      // when the server boots + each registered agent calls upsertAgent.
      try {
        await exec(`CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          version TEXT,
          capabilities TEXT DEFAULT '[]',
          input_schema TEXT,
          output_schema TEXT,
          enabled INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      try {
        await exec(`CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          agent_id TEXT NOT NULL,
          user_id TEXT,
          input TEXT,
          output TEXT,
          status TEXT DEFAULT 'running',
          error TEXT,
          cost_usd_cents INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          duration_ms INTEGER,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      try {
        await exec(`CREATE TABLE IF NOT EXISTS agent_traces (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          data TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      try {
        await exec(`CREATE TABLE IF NOT EXISTS content_pieces (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          type TEXT,
          title TEXT,
          body TEXT,
          metadata TEXT DEFAULT '{}',
          status TEXT DEFAULT 'draft',
          created_by_agent_run_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      try {
        await exec(`CREATE TABLE IF NOT EXISTS brand_voices (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          style_guide TEXT,
          tone_words TEXT DEFAULT '[]',
          do_examples TEXT DEFAULT '[]',
          dont_examples TEXT DEFAULT '[]',
          is_default INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      try {
        await exec(`CREATE TABLE IF NOT EXISTS conductor_plans (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          plan TEXT NOT NULL,
          status TEXT DEFAULT 'pending_approval',
          created_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          approved_at TIMESTAMP,
          completed_at TIMESTAMP
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

      // Indexes
      for (const stmt of [
        'CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id)',
        'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id)',
        'CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)',
        'CREATE INDEX IF NOT EXISTS idx_agent_traces_run ON agent_traces(run_id)',
        'CREATE INDEX IF NOT EXISTS idx_content_pieces_workspace ON content_pieces(workspace_id)',
        'CREATE INDEX IF NOT EXISTS idx_brand_voices_workspace ON brand_voices(workspace_id)',
        'CREATE INDEX IF NOT EXISTS idx_conductor_plans_workspace ON conductor_plans(workspace_id)',
      ]) {
        try { await exec(stmt); } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
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

  {
    id: '2026-04-22-inbox-messages',
    description: 'Community Agent inbox_messages table — unified mentions / comments / DMs across platforms',
    up: async ({ exec }) => {
      // One table for all inbound community touchpoints. Platform-specific
      // columns (thread_id, parent_id) are nullable because not every
      // platform exposes them. `raw` stores the original payload for
      // future fields we haven't surfaced yet.
      try {
        await exec(`CREATE TABLE IF NOT EXISTS inbox_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          kind TEXT NOT NULL,
          external_id TEXT,
          thread_id TEXT,
          parent_id TEXT,
          author_handle TEXT,
          author_name TEXT,
          author_avatar_url TEXT,
          text TEXT,
          url TEXT,
          sentiment TEXT,
          priority TEXT DEFAULT 'normal',
          status TEXT DEFAULT 'open',
          assignee_user_id TEXT,
          draft_reply TEXT,
          replied_at TIMESTAMP,
          occurred_at TIMESTAMP,
          fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          raw TEXT,
          tags TEXT DEFAULT '[]'
        )`);
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
      // Uniqueness per (workspace, platform, external_id) prevents dup-pulls.
      try { await exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_messages_ext ON inbox_messages(workspace_id, platform, external_id)'); } catch {}
      try { await exec('CREATE INDEX IF NOT EXISTS idx_inbox_messages_ws_status ON inbox_messages(workspace_id, status)'); } catch {}
      try { await exec('CREATE INDEX IF NOT EXISTS idx_inbox_messages_occurred ON inbox_messages(workspace_id, occurred_at DESC)'); } catch {}
    },
  },

  {
    id: '2026-04-22-brand-voice-embeddings',
    description: 'pgvector extension + embedding column on brand_voices (Postgres only; SQLite stores JSON floats fallback)',
    up: async ({ exec }) => {
      const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '');
      if (isPostgres) {
        // pgvector is available on Cloud SQL PG15 as a shared_preload extension.
        // CREATE EXTENSION requires superuser-ish perms; on Cloud SQL the
        // `cloudsqlsuperuser` role can run it. If the caller lacks perms we
        // swallow and fall through — the column add below will fail loudly and
        // the operator can enable the extension manually.
        try { await exec('CREATE EXTENSION IF NOT EXISTS vector'); } catch (e) {
          console.warn('[migration] could not CREATE EXTENSION vector — run it as a superuser:', e.message);
        }
        try { await exec('ALTER TABLE brand_voices ADD COLUMN embedding vector(1536)'); } catch (e) {
          if (!/already exists|duplicate column/i.test(e.message)) throw e;
        }
        // IVFFlat index for cosine similarity. Tuning: lists ≈ sqrt(rows); we
        // start with 100, expecting ≤10K brand_voices per installation.
        try {
          await exec(
            'CREATE INDEX IF NOT EXISTS idx_brand_voices_embedding ON brand_voices USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)'
          );
        } catch (e) {
          // IVFFlat needs rows to build; ignore if table is empty or index driver chokes.
          if (!/already exists|empty/i.test(e.message)) console.warn('[migration] ivfflat index skipped:', e.message);
        }
      } else {
        // SQLite fallback: store embedding as JSON text; similarity is computed
        // in-process. Keeps the migration idempotent across drivers — the
        // column name `embedding` is the same so application code is portable.
        try { await exec('ALTER TABLE brand_voices ADD COLUMN embedding TEXT'); } catch (e) {
          if (!/duplicate column/i.test(e.message)) throw e;
        }
      }
      // Dimension + model columns let us migrate to a different embedding
      // model later without orphaning existing rows.
      try { await exec('ALTER TABLE brand_voices ADD COLUMN embedding_model TEXT'); } catch (e) {
        if (!/already exists|duplicate column/i.test(e.message)) throw e;
      }
      try { await exec('ALTER TABLE brand_voices ADD COLUMN embedding_dims INTEGER'); } catch (e) {
        if (!/already exists|duplicate column/i.test(e.message)) throw e;
      }
    },
  },

  {
    id: '2026-04-23-sched-publish-retry',
    description: 'next_retry_at + max_attempts + error_message on scheduled_publishes for retry-with-backoff',
    up: async ({ exec }) => {
      // Backoff window persisted per-row so we survive server restarts.
      // A row stays 'pending' across retries and only flips to 'error' when
      // attempts ≥ max_attempts. The due-query treats next_retry_at as the
      // effective scheduled_at (coalesce in scheduled-publish.js).
      for (const stmt of [
        'ALTER TABLE scheduled_publishes ADD COLUMN next_retry_at TIMESTAMP',
        'ALTER TABLE scheduled_publishes ADD COLUMN max_attempts INTEGER DEFAULT 3',
        'ALTER TABLE scheduled_publishes ADD COLUMN error_message TEXT',
      ]) {
        try { await exec(stmt); } catch (e) {
          if (!/already exists|duplicate column/i.test(e.message)) throw e;
        }
      }
      try {
        await exec('CREATE INDEX IF NOT EXISTS idx_sched_pub_retry ON scheduled_publishes(status, next_retry_at)');
      } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
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
