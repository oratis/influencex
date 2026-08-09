/**
 * Creator Marketplace — the shared, cross-workspace creator catalog
 * (roadmap D2, docs/ROADMAP_2026-Q2.md).
 *
 * ## Why this table is NOT workspace-scoped
 *
 * Every other business table in this schema is scoped by workspace_id and the
 * `scoped()` helper in database.js refuses SQL that forgets it. `creators_public`
 * is the deliberate exception: a marketplace whose rows only one tenant can see
 * is not a marketplace. Workspace A contributes the creators it discovered,
 * workspace B browses them, and both add whoever they like to their own
 * campaigns.
 *
 * That inversion is only safe because of the rule this module exists to enforce:
 *
 *   **The catalog stores public-profile fields and nothing else.**
 *
 * A creator's public profile page already shows their handle, display name,
 * avatar, follower count, engagement and category to anyone with a browser.
 * Republishing those in a catalog exposes nothing that was private. Everything
 * a workspace learns *privately* — the email address it found, the contact
 * notes it wrote, which campaign it linked the creator to, the outreach draft
 * it generated, its AI fit score — stays in that workspace's `kol_database`
 * and `kols` rows and never crosses this boundary.
 *
 * Two mechanisms keep that true rather than merely intended:
 *
 *   1. `CATALOG_FIELDS_FROM_KOL` is the *only* column list read out of
 *      `kol_database` on the contribute path. Adding a private column to the
 *      catalog would mean adding it here, in a file whose tests assert the
 *      list contains none of PRIVATE_KOL_FIELDS.
 *   2. `toPublicCreator()` is the *only* way a catalog row becomes an API
 *      response. It builds a fresh object key by key, so a stray column on the
 *      row — today's or a future migration's — cannot ride along.
 *
 * ## Provenance (ROADMAP_2026-Q2 §5, "Marketplace 种子数据合规")
 *
 * Every row records which workspace contributed it, when, and that the source
 * was a public profile page. `contributed_by_workspace_id` is for auditing and
 * takedown requests only — it is NOT part of the API response, because "which
 * workspace is tracking this creator" is itself tenant-private.
 */

const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Field allowlists
// ---------------------------------------------------------------------------

/**
 * The complete set of keys a marketplace API response may contain. Anything
 * not listed here never reaches a client.
 */
const PUBLIC_CREATOR_FIELDS = [
  'id',
  'platform',
  'username',
  'display_name',
  'avatar_url',
  'profile_url',
  'followers',
  'engagement_rate',
  'category',
  // Provenance shown to the user: what kind of source this came from and when
  // it was listed. Never the contributing workspace's id.
  'source',
  'listed_at',
  'is_sample',
];

/**
 * Columns copied out of a workspace's `kol_database` row when it is promoted
 * into the catalog. Public profile data only.
 *
 * Explicitly excluded, and asserted to be excluded in the tests:
 * email, outreach_email_subject, outreach_email_body, ai_score, ai_reason,
 * estimated_cpm, tags, source_campaign_id, scrape_error, bio, workspace_id.
 */
const CATALOG_FIELDS_FROM_KOL = [
  'platform',
  'username',
  'display_name',
  'avatar_url',
  'profile_url',
  'followers',
  'engagement_rate',
  'category',
];

/**
 * Fields that must never appear in the catalog or in a marketplace response.
 * Exported so the guarantee is testable rather than aspirational.
 */
const PRIVATE_KOL_FIELDS = [
  'email',
  'contact_info',
  'outreach_email_subject',
  'outreach_email_body',
  'ai_score',
  'ai_reason',
  'estimated_cpm',
  'source_campaign_id',
  'scrape_error',
  'scrape_status',
  'tags',
  'notes',
  'workspace_id',
  'contributed_by_workspace_id',
];

// Pagination: generous enough for an infinite-scroll grid, small enough that
// the catalog can't be drained in one call.
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const SORTS = {
  followers: 'followers DESC, username ASC',
  engagement: 'engagement_rate DESC, username ASC',
  recent: 'contributed_at DESC, username ASC',
};
const DEFAULT_SORT = 'followers';

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Turn a `creators_public` row into the public API shape.
 *
 * Built key-by-key from PUBLIC_CREATOR_FIELDS — never a spread of the row —
 * so that a column added by a later migration (or a row that somehow carries
 * an `email`) cannot leak through. This is the single choke point between the
 * catalog table and the network.
 */
function toPublicCreator(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    username: row.username,
    display_name: row.display_name || row.username,
    avatar_url: row.avatar_url || '',
    profile_url: row.profile_url || '',
    followers: Number(row.followers) || 0,
    engagement_rate: Number(row.engagement_rate) || 0,
    category: row.category || '',
    source: row.source || 'public_profile',
    listed_at: row.contributed_at || row.created_at || null,
    is_sample: Number(row.is_sample) === 1,
  };
}

// ---------------------------------------------------------------------------
// Listing / search
// ---------------------------------------------------------------------------

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function clampOffset(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Build the WHERE clause shared by the page query and the count query.
 *
 * Dual-dialect notes:
 *   - `LOWER(col) LIKE ?` rather than ILIKE: Postgres has ILIKE, SQLite does
 *     not, and plain LIKE is case-sensitive in Postgres but not SQLite. Lower
 *     both sides and the two engines agree.
 *   - `%` and `_` in user input are escaped so a search for "a_b" doesn't
 *     become a wildcard sweep.
 */
function buildFilters({ platform, category, min_followers, q } = {}) {
  const clauses = [];
  const params = [];

  if (platform) {
    clauses.push('LOWER(platform) = ?');
    params.push(String(platform).toLowerCase());
  }
  if (category) {
    clauses.push('LOWER(category) = ?');
    params.push(String(category).toLowerCase());
  }
  const min = parseInt(min_followers, 10);
  if (Number.isFinite(min) && min > 0) {
    clauses.push('followers >= ?');
    params.push(min);
  }
  const term = (q || '').trim();
  if (term) {
    const needle = `%${term.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
    clauses.push("(LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(display_name) LIKE ? ESCAPE '\\')");
    params.push(needle, needle);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * SQL + params for one page of the catalog, and for its total count.
 *
 * The SELECT names its columns instead of using `*`: the projection is part
 * of the privacy contract, not a formatting preference.
 */
function buildListQuery(query = {}) {
  const { where, params } = buildFilters(query);
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const order = SORTS[query.sort] || SORTS[DEFAULT_SORT];

  const projection =
    'SELECT id, platform, username, display_name, avatar_url, profile_url, ' +
    'followers, engagement_rate, category, source, contributed_at, is_sample';
  const from = where
    ? `FROM creators_public ${where}`
    : 'FROM creators_public';

  return {
    sql: `${projection} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
    countSql: `SELECT COUNT(*) as count ${from}`,
    countParams: params,
    limit,
    offset,
  };
}

/** Distinct non-empty categories, for the filter dropdown. Public data. */
const CATEGORIES_SQL =
  "SELECT DISTINCT category FROM creators_public WHERE category IS NOT NULL AND category <> '' " +
  'ORDER BY category LIMIT 60';

// ---------------------------------------------------------------------------
// Contribute: workspace kol_database -> shared catalog
// ---------------------------------------------------------------------------

/**
 * SELECT for the contribute path. Lists the public columns explicitly (plus
 * `id`, which is only used for logging and never stored in the catalog) and
 * takes only rows whose scrape actually completed — a pending/failed row has
 * no verified public data to publish.
 */
function buildContributeSourceQuery(workspaceId, { limit = 500 } = {}) {
  return {
    sql:
      `SELECT id, ${CATALOG_FIELDS_FROM_KOL.join(', ')} FROM kol_database ` +
      "WHERE workspace_id = ? AND scrape_status = 'complete' " +
      "AND username IS NOT NULL AND username <> '' " +
      'ORDER BY followers DESC LIMIT ?',
    params: [workspaceId, Math.min(parseInt(limit, 10) || 500, 1000)],
  };
}

/**
 * Map a scraped `kol_database` row to a catalog row.
 *
 * Returns null when the row lacks the minimum a listing needs (platform +
 * username). Copies only CATALOG_FIELDS_FROM_KOL and stamps provenance:
 * source = 'public_profile' (the data came off the creator's public page),
 * the contributing workspace, and the timestamp.
 */
function toCatalogRow(kolRow, workspaceId) {
  if (!kolRow) return null;
  const platform = (kolRow.platform || '').trim().toLowerCase();
  const username = (kolRow.username || '').trim();
  if (!platform || !username) return null;

  return {
    id: uuidv4(),
    platform,
    username,
    display_name: kolRow.display_name || username,
    avatar_url: kolRow.avatar_url || '',
    profile_url: kolRow.profile_url || '',
    followers: Number(kolRow.followers) || 0,
    engagement_rate: Number(kolRow.engagement_rate) || 0,
    category: kolRow.category || '',
    // Provenance — ROADMAP_2026-Q2 §5.
    source: 'public_profile',
    contributed_by_workspace_id: workspaceId,
    is_sample: 0,
  };
}

const CATALOG_INSERT_SQL =
  'INSERT INTO creators_public ' +
  '(id, platform, username, display_name, avatar_url, profile_url, followers, ' +
  'engagement_rate, category, source, contributed_by_workspace_id, is_sample) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function catalogInsertParams(row) {
  return [
    row.id, row.platform, row.username, row.display_name, row.avatar_url,
    row.profile_url, row.followers, row.engagement_rate, row.category,
    row.source, row.contributed_by_workspace_id, row.is_sample,
  ];
}

/**
 * Refresh statement for a listing this same workspace contributed earlier.
 *
 * Scoped to `contributed_by_workspace_id = ?` and `is_sample = 0` on purpose:
 * one tenant must never be able to rewrite another tenant's listing (that is
 * the S-1 cross-workspace-overwrite bug in a new costume), and the sample rows
 * are never silently turned into something that looks real.
 */
const CATALOG_REFRESH_SQL =
  'UPDATE creators_public SET display_name = ?, avatar_url = ?, profile_url = ?, ' +
  'followers = ?, engagement_rate = ?, category = ?, contributed_at = CURRENT_TIMESTAMP, ' +
  'updated_at = CURRENT_TIMESTAMP ' +
  'WHERE platform = ? AND username = ? AND contributed_by_workspace_id = ? AND is_sample = 0';

function catalogRefreshParams(row) {
  return [
    row.display_name, row.avatar_url, row.profile_url, row.followers,
    row.engagement_rate, row.category,
    row.platform, row.username, row.contributed_by_workspace_id,
  ];
}

// ---------------------------------------------------------------------------
// Add to campaign: shared catalog -> the caller's own workspace
// ---------------------------------------------------------------------------

/**
 * INSERT that copies a catalog listing into the caller's `kols` table.
 *
 * workspace_id is in the column list and is not optional — a `kols` row with a
 * NULL workspace_id is invisible to every workspace-scoped read, which is
 * exactly the P0-3 bug (docs/E2E_REVIEW_2026-08.md) that let pipeline output
 * fall into a black hole. `email` and `contact_info` are seeded empty because
 * the catalog has no such data to give.
 */
const ADD_TO_CAMPAIGN_SQL =
  'INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, ' +
  "avatar_url, followers, engagement_rate, category, profile_url, email, contact_info, status) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '{}', 'pending')";

function addToCampaignParams(creator, { workspaceId, campaignId, kolId }) {
  return [
    kolId || uuidv4(),
    workspaceId,
    campaignId,
    creator.platform,
    creator.username,
    creator.display_name || creator.username,
    creator.avatar_url || '',
    Number(creator.followers) || 0,
    Number(creator.engagement_rate) || 0,
    creator.category || '',
    creator.profile_url || '',
  ];
}

module.exports = {
  PUBLIC_CREATOR_FIELDS,
  CATALOG_FIELDS_FROM_KOL,
  PRIVATE_KOL_FIELDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORTS,
  toPublicCreator,
  buildFilters,
  buildListQuery,
  CATEGORIES_SQL,
  clampLimit,
  clampOffset,
  buildContributeSourceQuery,
  toCatalogRow,
  CATALOG_INSERT_SQL,
  catalogInsertParams,
  CATALOG_REFRESH_SQL,
  catalogRefreshParams,
  ADD_TO_CAMPAIGN_SQL,
  addToCampaignParams,
};
