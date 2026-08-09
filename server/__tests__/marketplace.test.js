/**
 * Creator Marketplace tests (roadmap D2).
 *
 * The marketplace inverts this codebase's default: `creators_public` is the
 * one table every workspace can read. That is only safe if the table cannot
 * hold — and the API cannot emit — anything private. These tests exist to make
 * that a checked property rather than a code-review habit:
 *
 *   1. schema + uniqueness: one listing per (platform, username).
 *   2. listing / filtering / pagination SQL runs against the real migrated
 *      schema in the SQLite dialect (production is Postgres; the statements
 *      are written to compile on both, see marketplace.js).
 *   3. NO PRIVATE DATA: `toPublicCreator()` is the only path from row to
 *      response, and it drops private columns even when the row carries them.
 *   4. add-to-campaign writes a workspace-scoped `kols` row with workspace_id
 *      set (the P0-3 failure mode from docs/E2E_REVIEW_2026-08.md).
 *   5. contribute reads only public columns out of kol_database, stamps
 *      provenance, and cannot overwrite another workspace's listing.
 *
 * Permission wiring for the three routes is asserted in rbac-routes.test.js,
 * which parses server/index.js.
 *
 * Isolation: SQLITE_DB_PATH points at a throwaway file so `npm test` never
 * touches the repo-root influencex.db, same as schema-contract.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const TMP_DB = path.join(
  os.tmpdir(),
  `influencex-marketplace-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DATABASE_URL = '';

const { query, queryOne, exec, initializeDatabase, assertContainsWorkspaceScope } = require('../database');
const { runPendingMigrations } = require('../migrations');
const mkt = require('../marketplace');

const WS_A = 'ws-marketplace-a';
const WS_B = 'ws-marketplace-b';

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TMP_DB + suffix, { force: true });
  }
});

// Wipe only the rows this suite creates; leave the migration's sample rows
// alone where a test needs them, and re-assert a clean slate where it doesn't.
async function clearContributed() {
  await exec('DELETE FROM creators_public WHERE is_sample = 0');
}

async function insertCatalogRow(overrides = {}) {
  const row = {
    id: uuidv4(),
    platform: 'youtube',
    username: `user-${crypto.randomBytes(3).toString('hex')}`,
    display_name: 'Some Creator',
    avatar_url: 'https://cdn.example.org/a.png',
    profile_url: 'https://www.youtube.com/@somebody',
    followers: 1000,
    engagement_rate: 3.5,
    category: 'tech',
    source: 'public_profile',
    contributed_by_workspace_id: WS_A,
    is_sample: 0,
    ...overrides,
  };
  await exec(mkt.CATALOG_INSERT_SQL, mkt.catalogInsertParams(row));
  return row;
}

// ==================== 1. Schema + uniqueness ====================

// `query()` dispatches on the leading keyword, so use the pragma *function*
// (SELECT-shaped) rather than the `PRAGMA ...` statement form.
const COLUMNS_SQL = "SELECT name FROM pragma_table_info('creators_public')";

test('migration creates creators_public with the public + provenance columns', async () => {
  const cols = (await query(COLUMNS_SQL)).rows.map(c => c.name);
  for (const c of [
    'id', 'platform', 'username', 'display_name', 'avatar_url', 'profile_url',
    'followers', 'engagement_rate', 'category',
    'source', 'contributed_by_workspace_id', 'contributed_at', 'is_sample',
  ]) {
    assert.ok(cols.includes(c), `creators_public is missing column ${c}`);
  }
});

test('creators_public carries NO private column', async () => {
  const cols = (await query(COLUMNS_SQL)).rows.map(c => c.name);
  for (const forbidden of ['email', 'contact_info', 'outreach_email_subject', 'outreach_email_body', 'ai_score', 'ai_reason', 'source_campaign_id']) {
    assert.ok(!cols.includes(forbidden), `creators_public must not have a ${forbidden} column`);
  }
});

test('(platform, username) is unique — the same creator cannot be listed twice', async () => {
  await clearContributed();
  const row = await insertCatalogRow({ platform: 'tiktok', username: 'dup-check' });
  await assert.rejects(
    () => insertCatalogRow({ platform: 'tiktok', username: 'dup-check', id: uuidv4() }),
    /UNIQUE|constraint/i
  );
  // Different platform, same handle, is a different creator and is allowed.
  await insertCatalogRow({ platform: 'youtube', username: 'dup-check' });
  assert.equal(row.platform, 'tiktok');
});

test('the indexes the listing queries rely on exist', async () => {
  const idx = (await query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='creators_public'")).rows.map(r => r.name);
  for (const name of [
    'idx_creators_public_identity',
    'idx_creators_public_platform',
    'idx_creators_public_followers',
    'idx_creators_public_category',
  ]) {
    assert.ok(idx.includes(name), `missing index ${name}`);
  }
});

// ==================== 2. Listing / filtering / pagination ====================

test('sample rows are seeded, labelled, and point at example.com', async () => {
  const samples = (await query('SELECT * FROM creators_public WHERE is_sample = 1')).rows;
  assert.ok(samples.length > 0, 'expected the migration to seed sample rows');
  assert.ok(samples.length <= 10, 'the sample set must stay small');
  for (const s of samples) {
    assert.match(s.display_name, /^Sample Creator /, 'sample rows must be named unmistakably');
    assert.match(s.profile_url, /^https:\/\/example\.com\//, 'sample URLs must be example.com');
    assert.equal(s.source, 'sample');
    assert.equal(s.contributed_by_workspace_id, null);
  }
});

test('listing returns the rows and a total that matches the filtered set', async () => {
  await clearContributed();
  await insertCatalogRow({ platform: 'youtube', username: 'list-a', followers: 5000 });
  await insertCatalogRow({ platform: 'tiktok', username: 'list-b', followers: 90000 });

  const { sql, params, countSql, countParams } = mkt.buildListQuery({});
  const rows = (await query(sql, params)).rows;
  const total = Number((await queryOne(countSql, countParams)).count);
  const everything = Number((await queryOne('SELECT COUNT(*) as count FROM creators_public')).count);

  assert.equal(total, everything, 'an unfiltered count must cover the whole catalog');
  assert.equal(rows.length, Math.min(everything, mkt.DEFAULT_LIMIT));

  // Default sort is followers DESC.
  const followers = rows.map(r => Number(r.followers));
  assert.deepEqual(followers, [...followers].sort((a, b) => b - a));

  // A filtered count tracks the filter, not the table.
  const filtered = mkt.buildListQuery({ platform: 'tiktok' });
  const filteredTotal = Number((await queryOne(filtered.countSql, filtered.countParams)).count);
  const filteredRows = (await query(filtered.sql, filtered.params)).rows;
  assert.equal(filteredTotal, filteredRows.length);
  assert.ok(filteredTotal < everything);
});

test('platform / category / min-followers / search filters each narrow the result', async () => {
  await clearContributed();
  await exec('DELETE FROM creators_public WHERE is_sample = 1');
  await insertCatalogRow({ platform: 'youtube', username: 'alpha-gamer', display_name: 'Alpha Gamer', followers: 250000, category: 'gaming' });
  await insertCatalogRow({ platform: 'tiktok', username: 'beta-chef', display_name: 'Beta Chef', followers: 12000, category: 'food' });
  await insertCatalogRow({ platform: 'youtube', username: 'gamma-tech', display_name: 'Gamma Tech', followers: 800, category: 'tech' });

  const run = async (filters) => {
    const { sql, params } = mkt.buildListQuery(filters);
    return (await query(sql, params)).rows;
  };

  assert.deepEqual((await run({ platform: 'youtube' })).map(r => r.username).sort(), ['alpha-gamer', 'gamma-tech']);
  // Filter matching is case-insensitive in both dialects (LOWER on both sides).
  assert.deepEqual((await run({ platform: 'YouTube' })).map(r => r.username).sort(), ['alpha-gamer', 'gamma-tech']);
  assert.deepEqual((await run({ category: 'food' })).map(r => r.username), ['beta-chef']);
  assert.deepEqual((await run({ min_followers: 10000 })).map(r => r.username).sort(), ['alpha-gamer', 'beta-chef']);
  assert.deepEqual((await run({ q: 'chef' })).map(r => r.username), ['beta-chef']);
  assert.deepEqual((await run({ q: 'GAMMA' })).map(r => r.username), ['gamma-tech'], 'search is case-insensitive');
  assert.deepEqual((await run({ platform: 'youtube', min_followers: 100000 })).map(r => r.username), ['alpha-gamer']);
  assert.deepEqual(await run({ q: 'nobody-here' }), []);
});

test('search wildcards in user input are escaped, not executed', async () => {
  await clearContributed();
  await exec('DELETE FROM creators_public WHERE is_sample = 1');
  await insertCatalogRow({ platform: 'youtube', username: 'a_b', display_name: 'Underscore' });
  await insertCatalogRow({ platform: 'youtube', username: 'axb', display_name: 'Wildcard bait' });

  const { sql, params } = mkt.buildListQuery({ q: 'a_b' });
  const rows = (await query(sql, params)).rows;
  assert.deepEqual(rows.map(r => r.username), ['a_b'], '"_" must be a literal, not a single-char wildcard');
});

test('pagination is capped and offsets correctly', async () => {
  await clearContributed();
  await exec('DELETE FROM creators_public WHERE is_sample = 1');
  for (let i = 0; i < 5; i++) {
    await insertCatalogRow({ platform: 'youtube', username: `page-${i}`, followers: 1000 * (5 - i) });
  }

  const p1 = mkt.buildListQuery({ limit: 2, offset: 0 });
  const p2 = mkt.buildListQuery({ limit: 2, offset: 2 });
  const r1 = (await query(p1.sql, p1.params)).rows.map(r => r.username);
  const r2 = (await query(p2.sql, p2.params)).rows.map(r => r.username);
  assert.deepEqual(r1, ['page-0', 'page-1']);
  assert.deepEqual(r2, ['page-2', 'page-3']);

  // A caller asking for the whole table gets the cap, not the whole table.
  assert.equal(mkt.buildListQuery({ limit: 100000 }).limit, mkt.MAX_LIMIT);
  assert.equal(mkt.buildListQuery({ limit: 'abc' }).limit, mkt.DEFAULT_LIMIT);
  assert.equal(mkt.buildListQuery({ limit: -5 }).limit, mkt.DEFAULT_LIMIT);
  assert.equal(mkt.buildListQuery({ offset: -20 }).params.at(-1), 0);
});

test('the listing SELECT names its columns — never SELECT *', () => {
  const { sql, countSql } = mkt.buildListQuery({ platform: 'youtube' });
  assert.ok(!/SELECT\s+\*/i.test(sql), 'SELECT * would let a future column leak into the response');
  assert.ok(!/SELECT\s+\*/i.test(countSql));
  assert.ok(!/contributed_by_workspace_id/.test(sql), 'the contributing workspace must not be selected for the response');
});

// ==================== 3. The no-private-data guarantee ====================

test('toPublicCreator emits exactly the public field set', () => {
  const out = mkt.toPublicCreator({
    id: 'c1', platform: 'youtube', username: 'someone', display_name: 'Someone',
    avatar_url: 'a', profile_url: 'p', followers: 10, engagement_rate: 1.5,
    category: 'tech', source: 'public_profile', contributed_at: '2026-08-10', is_sample: 0,
  });
  assert.deepEqual(Object.keys(out).sort(), [...mkt.PUBLIC_CREATOR_FIELDS].sort());
});

test('toPublicCreator drops private fields even when the row carries them', () => {
  // Defence in depth: if a future migration, a bad join, or a hand-written
  // query ever puts private columns on the row, the mapper still cannot emit
  // them — it builds a fresh object instead of spreading.
  const poisoned = {
    id: 'c1', platform: 'youtube', username: 'someone', display_name: 'Someone',
    followers: 10, engagement_rate: 1.5, category: 'tech',
    source: 'public_profile', contributed_at: 'x', is_sample: 0,
    // Everything below must not survive.
    email: 'creator@example.org',
    contact_info: '{"phone":"+1 555 0100"}',
    outreach_email_subject: 'Partnership?',
    outreach_email_body: 'Hi there...',
    ai_score: 92,
    ai_reason: 'strong fit',
    estimated_cpm: 12.5,
    source_campaign_id: 'camp-1',
    scrape_status: 'complete',
    scrape_error: null,
    tags: '["vip"]',
    notes: 'called them twice',
    workspace_id: WS_A,
    contributed_by_workspace_id: WS_A,
  };
  const out = mkt.toPublicCreator(poisoned);
  const serialized = JSON.stringify(out);

  for (const field of mkt.PRIVATE_KOL_FIELDS) {
    assert.ok(!(field in out), `toPublicCreator leaked "${field}"`);
  }
  assert.ok(!/creator@example\.org/.test(serialized), 'email value leaked into the response body');
  assert.ok(!/555 0100/.test(serialized), 'contact info leaked into the response body');
  assert.ok(!/Partnership\?/.test(serialized), 'outreach draft leaked into the response body');
  assert.ok(!serialized.includes(WS_A), 'the contributing workspace id leaked into the response body');
});

test('the public field list itself contains nothing private', () => {
  for (const field of mkt.PRIVATE_KOL_FIELDS) {
    assert.ok(!mkt.PUBLIC_CREATOR_FIELDS.includes(field), `${field} must not be a public field`);
    assert.ok(!mkt.CATALOG_FIELDS_FROM_KOL.includes(field), `${field} must not be copied out of kol_database`);
  }
});

// ==================== 4. Add to campaign (workspace-scoped write) ====================

test('add-to-campaign INSERT sets workspace_id and passes the scope lint', async () => {
  const check = assertContainsWorkspaceScope(mkt.ADD_TO_CAMPAIGN_SQL);
  assert.ok(check.ok, `scope lint rejected the add-to-campaign INSERT: ${check.reason}`);
  assert.match(mkt.ADD_TO_CAMPAIGN_SQL, /INSERT INTO kols \(id, workspace_id, campaign_id/);
});

test('add-to-campaign writes a real kols row owned by the caller workspace', async () => {
  const campaignId = uuidv4();
  await exec(
    "INSERT INTO campaigns (id, workspace_id, name, status) VALUES (?, ?, 'MP campaign', 'active')",
    [campaignId, WS_A]
  );
  const creator = mkt.toPublicCreator({
    id: 'cat-1', platform: 'youtube', username: 'addme', display_name: 'Add Me',
    avatar_url: 'https://cdn.example.org/x.png', profile_url: 'https://www.youtube.com/@addme',
    followers: 4242, engagement_rate: 7.25, category: 'gaming',
    source: 'public_profile', contributed_at: '2026-08-10', is_sample: 0,
    // Private noise that must not make it into the kols row.
    email: 'addme@example.org', contributed_by_workspace_id: WS_B,
  });

  const kolId = uuidv4();
  await exec(mkt.ADD_TO_CAMPAIGN_SQL, mkt.addToCampaignParams(creator, {
    workspaceId: WS_A, campaignId, kolId,
  }));

  const row = await queryOne('SELECT * FROM kols WHERE id = ? AND workspace_id = ?', [kolId, WS_A]);
  assert.ok(row, 'the kols row must be visible to a workspace-scoped read (P0-3)');
  assert.equal(row.workspace_id, WS_A);
  assert.equal(row.campaign_id, campaignId);
  assert.equal(row.username, 'addme');
  assert.equal(row.followers, 4242);
  assert.equal(row.profile_url, 'https://www.youtube.com/@addme');
  assert.equal(row.status, 'pending');
  // The catalog has no contact data, so the copied row must not invent any.
  assert.equal(row.email, '');
  assert.equal(row.contact_info, '{}');

  // ...and it must be invisible to the other workspace.
  const leaked = await queryOne('SELECT id FROM kols WHERE id = ? AND workspace_id = ?', [kolId, WS_B]);
  assert.equal(leaked, undefined);
});

// ==================== 5. Contribute (workspace -> shared catalog) ====================

test('the contribute SELECT reads only public columns from kol_database', () => {
  const { sql, params } = mkt.buildContributeSourceQuery(WS_A);
  assert.ok(!/SELECT\s+\*/i.test(sql), 'SELECT * would drag private columns into the catalog');
  for (const field of ['email', 'outreach_email_subject', 'outreach_email_body', 'ai_score', 'ai_reason', 'estimated_cpm', 'tags', 'bio']) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(sql), `contribute SELECT must not read ${field}`);
  }
  assert.match(sql, /workspace_id = \?/, 'the source read must be workspace-scoped');
  assert.match(sql, /scrape_status = 'complete'/, 'only genuinely scraped rows are eligible');
  assert.equal(params[0], WS_A);
  const check = assertContainsWorkspaceScope(sql);
  assert.ok(check.ok, check.reason);
});

test('contribute maps a scraped KOL to a catalog row with provenance and no private data', () => {
  const scraped = {
    id: 'kdb-1',
    platform: 'YouTube',
    username: '  realcreator  ',
    display_name: 'Real Creator',
    avatar_url: 'https://cdn.example.org/r.png',
    profile_url: 'https://www.youtube.com/@realcreator',
    followers: 33000,
    engagement_rate: 5.5,
    category: 'tech',
    // If a caller ever hands the mapper a full row, none of this may survive.
    email: 'real@example.org',
    outreach_email_body: 'Hi Real...',
    ai_score: 88,
    workspace_id: WS_A,
  };
  const row = mkt.toCatalogRow(scraped, WS_A);

  assert.equal(row.platform, 'youtube', 'platform is normalised so dedupe works');
  assert.equal(row.username, 'realcreator', 'username is trimmed so dedupe works');
  assert.equal(row.source, 'public_profile', 'provenance: the data came off a public profile page');
  assert.equal(row.contributed_by_workspace_id, WS_A, 'provenance: which workspace contributed it');
  assert.equal(row.is_sample, 0);

  const serialized = JSON.stringify(row);
  assert.ok(!/real@example\.org/.test(serialized), 'email must never enter the catalog');
  assert.ok(!/Hi Real/.test(serialized), 'outreach draft must never enter the catalog');
  assert.ok(!('ai_score' in row), 'AI fit score is private analysis, not public profile data');
  assert.equal(mkt.toCatalogRow({ platform: 'youtube', username: '' }, WS_A), null);
  assert.equal(mkt.toCatalogRow(null, WS_A), null);
});

test('contribute stamps contributed_at and survives a round trip through the table', async () => {
  await clearContributed();
  const row = mkt.toCatalogRow(
    { platform: 'tiktok', username: 'prov-check', display_name: 'Prov', followers: 10, engagement_rate: 1, category: 'food' },
    WS_A
  );
  await exec(mkt.CATALOG_INSERT_SQL, mkt.catalogInsertParams(row));

  const stored = await queryOne('SELECT * FROM creators_public WHERE platform = ? AND username = ?', ['tiktok', 'prov-check']);
  assert.equal(stored.source, 'public_profile');
  assert.equal(stored.contributed_by_workspace_id, WS_A);
  assert.ok(stored.contributed_at, 'contributed_at must be recorded');
  assert.equal(stored.is_sample, 0);

  // And the API shape of that stored row still hides the contributor.
  const publicShape = mkt.toPublicCreator(stored);
  assert.ok(!('contributed_by_workspace_id' in publicShape));
  assert.equal(publicShape.source, 'public_profile');
});

test('a workspace can refresh its own listing but never another workspace\'s', async () => {
  await clearContributed();
  const original = mkt.toCatalogRow(
    { platform: 'youtube', username: 'shared-creator', display_name: 'Original Name', followers: 100, engagement_rate: 1, category: 'tech' },
    WS_A
  );
  await exec(mkt.CATALOG_INSERT_SQL, mkt.catalogInsertParams(original));

  // Workspace B scraped the same creator and tries to publish its version.
  const bVersion = mkt.toCatalogRow(
    { platform: 'youtube', username: 'shared-creator', display_name: 'B Hijack', followers: 999999, engagement_rate: 99, category: 'spam' },
    WS_B
  );
  const bResult = await exec(mkt.CATALOG_REFRESH_SQL, mkt.catalogRefreshParams(bVersion));
  assert.equal(bResult.rowCount, 0, 'workspace B must not be able to rewrite workspace A\'s listing');

  let stored = await queryOne('SELECT * FROM creators_public WHERE platform = ? AND username = ?', ['youtube', 'shared-creator']);
  assert.equal(stored.display_name, 'Original Name');
  assert.equal(stored.contributed_by_workspace_id, WS_A);

  // Workspace A re-contributing with fresher numbers does update.
  const aRefresh = mkt.toCatalogRow(
    { platform: 'youtube', username: 'shared-creator', display_name: 'Updated Name', followers: 250, engagement_rate: 2, category: 'tech' },
    WS_A
  );
  const aResult = await exec(mkt.CATALOG_REFRESH_SQL, mkt.catalogRefreshParams(aRefresh));
  assert.equal(aResult.rowCount, 1);
  stored = await queryOne('SELECT * FROM creators_public WHERE platform = ? AND username = ?', ['youtube', 'shared-creator']);
  assert.equal(stored.display_name, 'Updated Name');
  assert.equal(stored.followers, 250);
});

test('the refresh statement can never rewrite a sample row into something real', async () => {
  // Earlier tests clear the seeded samples for deterministic result sets, so
  // stand one back up rather than depending on suite ordering.
  await exec('DELETE FROM creators_public WHERE username = ?', ['sample-refresh-guard']);
  await exec(
    `INSERT INTO creators_public
       (id, platform, username, display_name, avatar_url, profile_url, followers,
        engagement_rate, category, source, contributed_by_workspace_id, is_sample)
     VALUES (?, 'youtube', 'sample-refresh-guard', 'Sample Creator Z',
             'https://example.com/avatars/z.png', 'https://example.com/youtube/sample-refresh-guard',
             1000, 2.0, 'gaming', 'sample', NULL, 1)`,
    [uuidv4()]
  );
  const sample = await queryOne('SELECT * FROM creators_public WHERE username = ?', ['sample-refresh-guard']);
  const impostor = mkt.toCatalogRow(
    { platform: sample.platform, username: sample.username, display_name: 'Totally Real Person', followers: 5000000, engagement_rate: 20, category: 'lifestyle' },
    WS_B
  );
  const r = await exec(mkt.CATALOG_REFRESH_SQL, mkt.catalogRefreshParams(impostor));
  assert.equal(r.rowCount, 0);
  const after = await queryOne('SELECT * FROM creators_public WHERE id = ?', [sample.id]);
  assert.equal(after.display_name, sample.display_name);
  assert.equal(after.is_sample, 1);
});
