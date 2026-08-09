/**
 * Direct access to the throwaway e2e SQLite database.
 *
 * Used for two things the HTTP API cannot do offline:
 *
 *   - Seeding a review-stage pipeline job. The real route to `stage='review'`
 *     is POST /api/pipeline/start → runPipeline(), whose first step is a live
 *     scrape (YouTube Data API / Apify). With every provider key blanked (see
 *     env.js) that route can only ever produce `stage='error'`, so the fixture
 *     writes the rows runPipeline's write stage writes — the exact statement
 *     shapes from server/index.js:5092-5135 — and the UI reads them back
 *     through the normal API.
 *   - Reading row state back for assertions (pipeline_jobs.stage,
 *     contacts.status) so a spec can pin what the app *really* produced.
 *
 * SQLite-only on purpose: the e2e webServer always runs the SQLite branch
 * (DATABASE_URL is pinned to ''), so the dual-dialect rule that governs
 * server code doesn't apply to this fixture.
 */

const crypto = require('crypto');
const Database = require('better-sqlite3');

const { DB_PATH } = require('../env');

function open() {
  const db = new Database(DB_PATH);
  // The server process holds the same file open. WAL + a busy timeout keeps
  // these cross-process writes from throwing SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function withDb(fn) {
  const db = open();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const uuid = () => crypto.randomUUID();

/** The demo admin's workspace + its first campaign, as created by seed-demo.js. */
function demoWorkspace() {
  return withDb((db) => {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('demo@influencex.dev');
    if (!user) throw new Error('demo admin missing — did global setup run the seeder?');
    const ws = db.prepare(
      'SELECT id, name FROM workspaces WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(user.id);
    if (!ws) throw new Error('demo workspace missing');
    const campaign = db.prepare(
      'SELECT id, name FROM campaigns WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(ws.id);
    if (!campaign) throw new Error('demo campaign missing');
    return { userId: user.id, workspaceId: ws.id, workspaceName: ws.name, campaignId: campaign.id };
  });
}

/**
 * Create a pipeline job parked at `stage='review'` with a linked draft
 * contact — i.e. the state runPipeline leaves behind after its write stage,
 * which is exactly what the approve button expects.
 *
 * Returns the ids plus the generated creator handle so the spec can find the
 * row in the UI by text.
 */
function seedReviewStageJob({ suffix } = {}) {
  const { workspaceId, campaignId } = demoWorkspace();
  const tag = suffix || uuid().slice(0, 8);
  const username = `e2e_creator_${tag}`;
  const displayName = `E2E Creator ${tag}`;
  const profileUrl = `https://youtube.com/@${username}`;
  const emailTo = `${username}@creators.example`;
  const subject = `Collab with ${displayName}?`;
  const body = `Hi ${displayName},\n\nWe love your work and would like to collaborate.\n\n— InfluenceX e2e`;

  const ids = {
    kolDatabaseId: uuid(),
    kolId: uuid(),
    contactId: uuid(),
    pipelineJobId: uuid(),
  };

  withDb((db) => {
    db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO kol_database (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, following, engagement_rate, avg_views, total_videos, category, email, bio, country, language, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id, updated_at)
         VALUES (?, ?, 'youtube', ?, ?, '', ?, ?, 0, ?, ?, ?, 'Gaming', ?, '', '', '', ?, 'e2e fixture', ?, 'complete', ?, CURRENT_TIMESTAMP)`
      ).run(ids.kolDatabaseId, workspaceId, username, displayName, profileUrl, 123456, 4.2, 45000, 120, emailTo, 77, 18, campaignId);

      db.prepare(
        `INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, profile_url, bio, ai_score, ai_reason, estimated_cpm, status)
         VALUES (?, ?, ?, 'youtube', ?, ?, '', ?, ?, ?, 'Gaming', ?, ?, '', ?, 'e2e fixture', ?, 'approved')`
      ).run(ids.kolId, workspaceId, campaignId, username, displayName, 123456, 4.2, 45000, emailTo, profileUrl, 77, 18);

      db.prepare(
        `INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, status)
         VALUES (?, ?, ?, ?, ?, ?, 'affiliate', 'draft')`
      ).run(ids.contactId, workspaceId, ids.kolId, campaignId, subject, body);

      db.prepare(
        `INSERT INTO pipeline_jobs (id, workspace_id, profile_url, platform, username, kol_database_id, contact_id, campaign_id, stage, email_subject, email_body, email_to, source)
         VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, 'review', ?, ?, ?, 'manual')`
      ).run(ids.pipelineJobId, workspaceId, profileUrl, username, ids.kolDatabaseId, ids.contactId, campaignId, subject, body, emailTo);
    })();
  });

  return { ...ids, workspaceId, campaignId, username, displayName, emailTo, subject, body };
}

function getPipelineJob(id) {
  return withDb(db => db.prepare('SELECT * FROM pipeline_jobs WHERE id = ?').get(id) || null);
}

function getContact(id) {
  return withDb(db => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null);
}

function countRows(table, where, params = []) {
  return withDb(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params).n);
}

/** Remove everything a seeded fixture created, so specs stay re-runnable. */
function cleanupFixture(fixture) {
  withDb((db) => {
    db.transaction(() => {
      db.prepare('DELETE FROM email_replies WHERE contact_id = ?').run(fixture.contactId);
      db.prepare('DELETE FROM email_events WHERE contact_id = ?').run(fixture.contactId);
      db.prepare('DELETE FROM pipeline_jobs WHERE id = ?').run(fixture.pipelineJobId);
      db.prepare('DELETE FROM contacts WHERE id = ?').run(fixture.contactId);
      db.prepare('DELETE FROM kols WHERE id = ?').run(fixture.kolId);
      db.prepare('DELETE FROM kol_database WHERE id = ?').run(fixture.kolDatabaseId);
    })();
  });
}

module.exports = {
  cleanupFixture,
  countRows,
  demoWorkspace,
  getContact,
  getPipelineJob,
  seedReviewStageJob,
  withDb,
};
