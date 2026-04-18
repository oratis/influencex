const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL || '';
const usePostgres = DATABASE_URL.startsWith('postgresql://') || DATABASE_URL.startsWith('postgres://');

let pool = null;
let db = null; // SQLite fallback

if (usePostgres) {
  const { Pool } = require('pg');
  const CLOUD_SQL_CONNECTION = process.env.CLOUD_SQL_CONNECTION || '';

  // On Cloud Run with Cloud SQL attached, K_SERVICE and CLOUD_SQL_CONNECTION
  // are both set — we connect via Unix socket, parsing credentials out of
  // DATABASE_URL (so users don't have to set them twice). DB_USER / DB_PASS /
  // DB_NAME env vars take precedence if explicitly set.
  //
  // Outside Cloud Run we use the DATABASE_URL connection string directly.
  let poolConfig;
  if (process.env.K_SERVICE && CLOUD_SQL_CONNECTION) {
    let parsed = {};
    try {
      const u = new URL(DATABASE_URL);
      parsed = {
        user: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        database: (u.pathname || '').replace(/^\//, ''),
      };
    } catch { /* fall through to env-var defaults */ }
    poolConfig = {
      user: process.env.DB_USER || parsed.user || 'postgres',
      password: process.env.DB_PASS || parsed.password || '',
      database: process.env.DB_NAME || parsed.database || 'postgres',
      host: `/cloudsql/${CLOUD_SQL_CONNECTION}`,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  } else {
    poolConfig = {
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });
} else {
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, '..', 'influencex.db'));
  db.pragma('journal_mode = WAL');
}

// ==================== Schema ====================

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    owner_user_id TEXT NOT NULL,
    plan TEXT DEFAULT 'starter',
    settings TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    joined_at TIMESTAMP DEFAULT NOW(),
    invited_by TEXT,
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
  CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    platforms TEXT DEFAULT '[]',
    daily_target INTEGER DEFAULT 10,
    filter_criteria TEXT DEFAULT '{}',
    budget REAL DEFAULT 0,
    budget_spent REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS kols (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    followers INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    avg_views INTEGER DEFAULT 0,
    category TEXT,
    email TEXT,
    contact_info TEXT DEFAULT '{}',
    profile_url TEXT,
    bio TEXT,
    ai_score REAL DEFAULT 0,
    ai_reason TEXT,
    estimated_cpm REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    collected_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    kol_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    email_subject TEXT,
    email_body TEXT,
    cooperation_type TEXT DEFAULT 'affiliate',
    price_quote TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TIMESTAMP,
    reply_content TEXT,
    reply_at TIMESTAMP,
    notes TEXT,
    contract_status TEXT DEFAULT 'none',
    contract_url TEXT,
    content_status TEXT DEFAULT 'not_started',
    content_url TEXT,
    content_due_date TEXT,
    payment_amount REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'unpaid',
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (kol_id) REFERENCES kols(id),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS content_data (
    id TEXT PRIMARY KEY,
    kol_name TEXT,
    platform TEXT,
    content_title TEXT,
    content_url TEXT,
    publish_date TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS registration_data (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    registrations INTEGER DEFAULT 0,
    source TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS kol_database (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    profile_url TEXT NOT NULL,
    followers INTEGER DEFAULT 0,
    following INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    avg_views INTEGER DEFAULT 0,
    total_videos INTEGER DEFAULT 0,
    category TEXT,
    email TEXT,
    bio TEXT,
    country TEXT,
    language TEXT,
    ai_score REAL DEFAULT 0,
    ai_reason TEXT,
    estimated_cpm REAL DEFAULT 0,
    outreach_email_subject TEXT,
    outreach_email_body TEXT,
    scrape_status TEXT DEFAULT 'pending',
    scrape_error TEXT,
    source_campaign_id TEXT,
    tags TEXT DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    profile_url TEXT NOT NULL,
    platform TEXT,
    username TEXT,
    kol_database_id TEXT,
    contact_id TEXT,
    campaign_id TEXT,
    stage TEXT DEFAULT 'scrape',
    scrape_result TEXT,
    email_subject TEXT,
    email_body TEXT,
    email_to TEXT,
    email_approved INTEGER DEFAULT 0,
    email_sent_at TIMESTAMP,
    smtp_message_id TEXT,
    reply_detected INTEGER DEFAULT 0,
    reply_content TEXT,
    error TEXT,
    source TEXT DEFAULT 'manual',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS content_scrape_cache (
    id TEXT PRIMARY KEY,
    content_url TEXT UNIQUE NOT NULL,
    platform TEXT,
    title TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    publish_date TEXT,
    scraped_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS dashboard_events (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    event_type TEXT,
    label TEXT NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS discovery_jobs (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    search_criteria TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    total_found INTEGER DEFAULT 0,
    total_processed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS discovery_results (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    platform TEXT,
    channel_url TEXT,
    channel_name TEXT,
    subscribers INTEGER DEFAULT 0,
    relevance_score REAL DEFAULT 0,
    pipeline_job_id TEXT,
    status TEXT DEFAULT 'found',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS content_daily_stats (
    id TEXT PRIMARY KEY,
    content_url TEXT NOT NULL,
    stat_date TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    source TEXT DEFAULT 'scrape',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(content_url, stat_date)
  );

  CREATE TABLE IF NOT EXISTS email_replies (
    id TEXT PRIMARY KEY,
    contact_id TEXT,
    pipeline_job_id TEXT,
    direction TEXT DEFAULT 'inbound',
    from_email TEXT,
    to_email TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    resend_email_id TEXT,
    in_reply_to TEXT,
    received_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_kols_campaign_id ON kols(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_kols_status ON kols(status);
  CREATE INDEX IF NOT EXISTS idx_contacts_kol_id ON contacts(kol_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_campaign_id ON contacts(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_stage ON pipeline_jobs(stage);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_email_to ON pipeline_jobs(email_to);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_campaign_id ON pipeline_jobs(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_kol_database_platform ON kol_database(platform);
  CREATE INDEX IF NOT EXISTS idx_kol_database_email ON kol_database(email);
  CREATE INDEX IF NOT EXISTS idx_kol_database_scrape_status ON kol_database(scrape_status);
  CREATE INDEX IF NOT EXISTS idx_email_replies_pipeline_job_id ON email_replies(pipeline_job_id);
  CREATE INDEX IF NOT EXISTS idx_email_replies_contact_id ON email_replies(contact_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_content_daily_stats_url ON content_daily_stats(content_url);
  CREATE INDEX IF NOT EXISTS idx_discovery_results_job_id ON discovery_results(job_id);
`;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    owner_user_id TEXT NOT NULL,
    plan TEXT DEFAULT 'starter',
    settings TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    invited_by TEXT,
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
  CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    platforms TEXT DEFAULT '[]',
    daily_target INTEGER DEFAULT 10,
    filter_criteria TEXT DEFAULT '{}',
    budget REAL DEFAULT 0,
    budget_spent REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kols (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    followers INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    avg_views INTEGER DEFAULT 0,
    category TEXT,
    email TEXT,
    contact_info TEXT DEFAULT '{}',
    profile_url TEXT,
    bio TEXT,
    ai_score REAL DEFAULT 0,
    ai_reason TEXT,
    estimated_cpm REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    kol_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    email_subject TEXT,
    email_body TEXT,
    cooperation_type TEXT DEFAULT 'affiliate',
    price_quote TEXT,
    status TEXT DEFAULT 'draft',
    sent_at DATETIME,
    reply_content TEXT,
    reply_at DATETIME,
    notes TEXT,
    contract_status TEXT DEFAULT 'none',
    contract_url TEXT,
    content_status TEXT DEFAULT 'not_started',
    content_url TEXT,
    content_due_date TEXT,
    payment_amount REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'unpaid',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (kol_id) REFERENCES kols(id),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS content_data (
    id TEXT PRIMARY KEY,
    kol_name TEXT,
    platform TEXT,
    content_title TEXT,
    content_url TEXT,
    publish_date TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS registration_data (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    registrations INTEGER DEFAULT 0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kol_database (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    profile_url TEXT NOT NULL,
    followers INTEGER DEFAULT 0,
    following INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    avg_views INTEGER DEFAULT 0,
    total_videos INTEGER DEFAULT 0,
    category TEXT,
    email TEXT,
    bio TEXT,
    country TEXT,
    language TEXT,
    ai_score REAL DEFAULT 0,
    ai_reason TEXT,
    estimated_cpm REAL DEFAULT 0,
    outreach_email_subject TEXT,
    outreach_email_body TEXT,
    scrape_status TEXT DEFAULT 'pending',
    scrape_error TEXT,
    source_campaign_id TEXT,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    profile_url TEXT NOT NULL,
    platform TEXT,
    username TEXT,
    kol_database_id TEXT,
    contact_id TEXT,
    campaign_id TEXT,
    stage TEXT DEFAULT 'scrape',
    scrape_result TEXT,
    email_subject TEXT,
    email_body TEXT,
    email_to TEXT,
    email_approved INTEGER DEFAULT 0,
    email_sent_at DATETIME,
    smtp_message_id TEXT,
    reply_detected INTEGER DEFAULT 0,
    reply_content TEXT,
    error TEXT,
    source TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_scrape_cache (
    id TEXT PRIMARY KEY,
    content_url TEXT UNIQUE NOT NULL,
    platform TEXT,
    title TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    publish_date TEXT,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS dashboard_events (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    event_type TEXT,
    label TEXT NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS discovery_jobs (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    search_criteria TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    total_found INTEGER DEFAULT 0,
    total_processed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS discovery_results (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    platform TEXT,
    channel_url TEXT,
    channel_name TEXT,
    subscribers INTEGER DEFAULT 0,
    relevance_score REAL DEFAULT 0,
    pipeline_job_id TEXT,
    status TEXT DEFAULT 'found',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_daily_stats (
    id TEXT PRIMARY KEY,
    content_url TEXT NOT NULL,
    stat_date TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    source TEXT DEFAULT 'scrape',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(content_url, stat_date)
  );

  CREATE TABLE IF NOT EXISTS email_replies (
    id TEXT PRIMARY KEY,
    contact_id TEXT,
    pipeline_job_id TEXT,
    direction TEXT DEFAULT 'inbound',
    from_email TEXT,
    to_email TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    resend_email_id TEXT,
    in_reply_to TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_kols_campaign_id ON kols(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_kols_status ON kols(status);
  CREATE INDEX IF NOT EXISTS idx_contacts_kol_id ON contacts(kol_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_campaign_id ON contacts(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_stage ON pipeline_jobs(stage);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_email_to ON pipeline_jobs(email_to);
  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_campaign_id ON pipeline_jobs(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_kol_database_platform ON kol_database(platform);
  CREATE INDEX IF NOT EXISTS idx_kol_database_email ON kol_database(email);
  CREATE INDEX IF NOT EXISTS idx_kol_database_scrape_status ON kol_database(scrape_status);
  CREATE INDEX IF NOT EXISTS idx_email_replies_pipeline_job_id ON email_replies(pipeline_job_id);
  CREATE INDEX IF NOT EXISTS idx_email_replies_contact_id ON email_replies(contact_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_content_daily_stats_url ON content_daily_stats(content_url);
  CREATE INDEX IF NOT EXISTS idx_discovery_results_job_id ON discovery_results(job_id);
`;

// ==================== Initialize ====================

async function initializeDatabase() {
  if (usePostgres) {
    // Execute each CREATE TABLE statement separately for PostgreSQL
    const statements = PG_SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    console.log('PostgreSQL tables initialized');
  } else {
    db.exec(SQLITE_SCHEMA);
    console.log('SQLite tables initialized');
  }
}

// ==================== Query helpers ====================

// Convert `?` placeholders to `$1, $2, ...` for PostgreSQL
function pgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ==================== Query timing instrumentation ====================

const queryStats = {
  total: 0,
  slowCount: 0,
  totalMs: 0,
  recentSlow: [],   // keep last 20 slow queries
};
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS) || 100;

function recordQueryTiming(sql, durationMs) {
  queryStats.total += 1;
  queryStats.totalMs += durationMs;
  if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
    queryStats.slowCount += 1;
    queryStats.recentSlow.unshift({
      sql: sql.slice(0, 200),
      durationMs: Math.round(durationMs),
      timestamp: new Date().toISOString(),
    });
    if (queryStats.recentSlow.length > 20) queryStats.recentSlow.length = 20;
    if (process.env.LOG_SLOW_QUERIES === 'true') {
      console.warn(`[slow-query ${Math.round(durationMs)}ms] ${sql.slice(0, 140)}`);
    }
  }
}

function getQueryStats() {
  return {
    total: queryStats.total,
    slowCount: queryStats.slowCount,
    avgMs: queryStats.total > 0 ? +(queryStats.totalMs / queryStats.total).toFixed(2) : 0,
    totalMs: Math.round(queryStats.totalMs),
    slowThresholdMs: SLOW_QUERY_THRESHOLD_MS,
    recentSlow: queryStats.recentSlow,
  };
}

// Unified query interface
// query(sql, params) -> { rows: [...] }
async function query(sql, params = []) {
  const start = Date.now();
  try {
    if (usePostgres) {
      return await pool.query(pgParams(sql), params);
    } else {
      // SQLite: detect query type
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('EXPLAIN')) {
        const rows = db.prepare(sql).all(...params);
        return { rows };
      } else {
        const info = db.prepare(sql).run(...params);
        return { rows: [], rowCount: info.changes };
      }
    }
  } finally {
    recordQueryTiming(sql, Date.now() - start);
  }
}

// queryOne(sql, params) -> row or undefined
async function queryOne(sql, params = []) {
  const start = Date.now();
  try {
    if (usePostgres) {
      const result = await pool.query(pgParams(sql), params);
      return result.rows[0];
    } else {
      return db.prepare(sql).get(...params);
    }
  } finally {
    recordQueryTiming(sql, Date.now() - start);
  }
}

// exec(sql, params) -> { rowCount }
async function exec(sql, params = []) {
  const start = Date.now();
  try {
    if (usePostgres) {
      const result = await pool.query(pgParams(sql), params);
      return { rowCount: result.rowCount };
    } else {
      const info = db.prepare(sql).run(...params);
      return { rowCount: info.changes };
    }
  } finally {
    recordQueryTiming(sql, Date.now() - start);
  }
}

// Transaction helper
async function transaction(fn) {
  if (usePostgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pgQuery = (sql, params = []) => client.query(pgParams(sql), params);
      const pgExec = pgQuery;
      const pgQueryOne = async (sql, params = []) => {
        const result = await client.query(pgParams(sql), params);
        return result.rows[0];
      };
      const result = await fn({ query: pgQuery, exec: pgExec, queryOne: pgQueryOne });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    // SQLite: use explicit BEGIN/COMMIT since the callback is async
    // (better-sqlite3's db.transaction() only wraps sync functions)
    db.exec('BEGIN');
    try {
      const txQuery = async (sql, params = []) => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
          return { rows: db.prepare(sql).all(...params) };
        } else {
          const info = db.prepare(sql).run(...params);
          return { rows: [], rowCount: info.changes };
        }
      };
      const txExec = txQuery;
      const txQueryOne = async (sql, params = []) => db.prepare(sql).get(...params);
      const result = await fn({ query: txQuery, exec: txExec, queryOne: txQueryOne });
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// ==================== Workspace-scoped query helper ====================
//
// Tables that do NOT need workspace_id scoping (global/platform-level data).
// Every other table must include a workspace_id filter or we refuse to run.
const WORKSPACE_EXEMPT_TABLES = new Set([
  'users', 'sessions',
  'workspaces', 'workspace_members',
  'schema_migrations',
]);

// Extract primary table name from a SQL statement. Best-effort; covers
// standard patterns. Returns lowercase table name or null if unrecognizable.
function extractTable(sql) {
  const s = sql.trim();
  // Strip leading comments
  const cleaned = s.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)+\s*/g, '');
  const patterns = [
    /^SELECT[\s\S]+?\bFROM\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /^UPDATE\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /^INSERT\s+INTO\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /^DELETE\s+FROM\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /^WITH\s+[\s\S]+?\bFROM\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Runtime lint: confirm a SQL statement either touches only exempt tables
 * or mentions workspace_id somewhere. Dev throws; prod warns (graceful
 * rollout of Day 3 handler migrations).
 *
 * Returns { ok, reason } so callers can inspect.
 */
function assertContainsWorkspaceScope(sql) {
  const table = extractTable(sql);
  if (!table) {
    // Can't identify table (e.g. "PRAGMA table_info(...)" or similar meta query).
    // Conservatively allow — these are never business data queries.
    return { ok: true, reason: 'no-table-extracted' };
  }
  if (WORKSPACE_EXEMPT_TABLES.has(table)) {
    return { ok: true, reason: 'exempt-table' };
  }
  // Must reference workspace_id somewhere in the statement
  if (/\bworkspace_id\b/i.test(sql)) {
    return { ok: true, reason: 'has-workspace-id' };
  }
  return { ok: false, reason: `table "${table}" requires workspace_id scope` };
}

function enforceScope(sql) {
  const check = assertContainsWorkspaceScope(sql);
  if (!check.ok) {
    const message = `[scope-violation] ${check.reason}. SQL: ${sql.slice(0, 200)}`;
    if (process.env.NODE_ENV === 'production' && process.env.STRICT_WORKSPACE_SCOPE !== 'true') {
      // Graceful during v1→v2 handler rollout. Flip STRICT_WORKSPACE_SCOPE=true
      // to make violations fatal in production once all handlers are migrated.
      console.warn(message);
    } else {
      throw new Error(message);
    }
  }
}

/**
 * Workspace-aware query wrappers.
 *
 *   const s = scoped(workspaceId);
 *   await s.query('SELECT ... FROM campaigns WHERE workspace_id = ?', [workspaceId]);
 *
 * The wrappers refuse to run SQL on business tables that lacks workspace_id
 * filtering — caller errors loudly in dev, warning in prod.
 *
 * NOTE: The caller still passes workspaceId explicitly in the params — we
 * do NOT magic-inject it. This keeps SQL readable and reviewable.
 */
function scoped(workspaceId) {
  if (!workspaceId) {
    throw new Error('scoped() requires a non-empty workspaceId');
  }
  return {
    workspaceId,
    query: (sql, params = []) => {
      enforceScope(sql);
      return query(sql, params);
    },
    queryOne: (sql, params = []) => {
      enforceScope(sql);
      return queryOne(sql, params);
    },
    exec: (sql, params = []) => {
      enforceScope(sql);
      return exec(sql, params);
    },
    transaction: (fn) => transaction(async (tx) => {
      const wrapped = {
        query: (sql, params = []) => { enforceScope(sql); return tx.query(sql, params); },
        queryOne: (sql, params = []) => { enforceScope(sql); return tx.queryOne(sql, params); },
        exec: (sql, params = []) => { enforceScope(sql); return tx.exec(sql, params); },
      };
      return fn(wrapped);
    }),
  };
}

module.exports = {
  pool,
  db,
  usePostgres,
  initializeDatabase,
  getQueryStats,
  query,
  queryOne,
  exec,
  transaction,
  // Workspace scoping
  scoped,
  assertContainsWorkspaceScope,
  extractTable,
  WORKSPACE_EXEMPT_TABLES,
};
