/**
 * discovery → pipeline → contact → send integration test (roadmap C3).
 *
 * Everything else in server/__tests__ is a unit test with hand-rolled deps.
 * This one wires the *real* pieces together against a *real* migrated SQLite
 * database and asserts the row transitions that the E2E review found nobody
 * was watching (`pipeline_jobs.stage`, `contacts.status`, queue handoff).
 *
 * Why not supertest against server/index.js?
 * ------------------------------------------
 * `server/index.js` exports nothing and calls `app.listen()` from a top-level
 * async IIFE, so `require()`-ing it boots a real HTTP listener, the scheduler,
 * the publish worker, the Apify watchdog, the inbox sync and 16 agents. Making
 * it importable means restructuring the 6.5k-line entrypoint — out of scope
 * for a test PR and exactly the kind of change that breaks production boot.
 * So the pieces that *are* modules (job-queue, email-jobs, database,
 * email-templates) run for real, and the parts that only exist inline in
 * index.js (the discovery-process loop and runPipeline's scrape/write stages)
 * are reproduced here statement-for-statement from index.js:5820-5828 and
 * index.js:5063-5135. If someone edits those statements without editing this
 * file, schema-contract.test.js is the second net that catches it.
 *
 * Isolation: SQLITE_DB_PATH (see server/database.js) points this process at a
 * throwaway file in os.tmpdir(), so the suite never touches the repo-root
 * influencex.db that the other DB-backed tests share.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Environment must be set before ../database is required: it picks its driver
// and opens the SQLite file at module load.
const TMP_DB = path.join(
  os.tmpdir(),
  `influencex-pipeline-int-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DATABASE_URL = '';
process.env.MAILBOX_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// Stub the LLM layer before anything can reach for it: no test may make a
// network call, and outreach copy must be deterministic.
const llmPath = require.resolve('../llm');
const llmCalls = [];
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  children: [],
  parent: null,
  exports: {
    isConfigured: () => true,
    complete: async (opts) => {
      llmCalls.push(opts);
      return { text: 'STUBBED_LLM_OUTPUT', provider: 'stub', model: 'stub-1' };
    },
  },
};

const { query, queryOne, exec, initializeDatabase, scoped } = require('../database');
const { runPendingMigrations } = require('../migrations');
const { createQueue } = require('../job-queue');
const emailJobs = require('../email-jobs');
const { renderEmail } = require('../email-templates');

const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// A mail provider stand-in whose behavior each test dictates.
function makeMailAgent({ configured = true, result } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => configured,
    sendEmail: async (payload) => {
      sent.push(payload);
      return result ? result(payload, sent.length) : { success: true, messageId: `msg-${sent.length}`, provider: 'stub' };
    },
  };
}

/** Real in-process queue with the real email.send handler registered on it. */
function makeQueue(mailAgent) {
  const queue = createQueue({ concurrency: 1, defaultMaxRetries: 1, baseBackoffMs: 5 });
  emailJobs.register({ jobQueue: queue, query, queryOne, exec, mailAgent });
  return queue;
}

// ---------------------------------------------------------------------------
// Fixture: a workspace with one campaign, as every tenant has.
let ws;

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TMP_DB + suffix, { force: true });
  }
});

beforeEach(async () => {
  const workspaceId = uuid();
  const userId = uuid();
  const campaignId = uuid();
  await exec(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
    [userId, `owner-${userId}@example.test`, 'x', 'Owner', 'admin']
  );
  await exec(
    'INSERT INTO workspaces (id, name, slug, owner_user_id, plan) VALUES (?, ?, ?, ?, ?)',
    [workspaceId, 'Integration WS', `int-${workspaceId.slice(0, 8)}`, userId, 'starter']
  );
  await exec(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
    [workspaceId, userId, 'admin']
  );
  await exec(
    'INSERT INTO campaigns (id, workspace_id, name, description, platforms, daily_target, budget, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [campaignId, workspaceId, 'Integration Campaign', 'e2e-ish', JSON.stringify(['youtube']), 5, 1000, 'active']
  );
  ws = { workspaceId, userId, campaignId };
});

// ---------------------------------------------------------------------------
// Stage helpers — the exact statements server/index.js runs, minus the HTTP
// and provider layers.

/** POST /api/discovery/... — a completed discovery run with one candidate. */
async function seedDiscoveryRun({ username }) {
  const jobId = uuid();
  const resultId = uuid();
  const channelUrl = `https://youtube.com/@${username}`;
  await exec(
    'INSERT INTO discovery_jobs (id, workspace_id, campaign_id, search_criteria, status) VALUES (?, ?, ?, ?, ?)',
    [jobId, ws.workspaceId, ws.campaignId, JSON.stringify({ keywords: 'gaming ai', platforms: ['youtube'] }), 'complete']
  );
  await exec(
    "INSERT INTO discovery_results (id, job_id, platform, channel_url, channel_name, subscribers, relevance_score, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [resultId, jobId, 'youtube', channelUrl, username, 120_000, 82, 'found']
  );
  await exec('UPDATE discovery_jobs SET total_found = 1 WHERE id = ?', [jobId]);
  return { jobId, resultId, channelUrl };
}

/** POST /api/discovery/jobs/:id/process — queue the candidate into the pipeline. */
async function processDiscoveryResult({ resultId, channelUrl, username }) {
  const pipelineJobId = uuid();
  await exec(
    "INSERT INTO pipeline_jobs (id, workspace_id, profile_url, platform, username, campaign_id, stage, source) VALUES (?, ?, ?, ?, ?, ?, 'scrape', 'discovery')",
    [pipelineJobId, ws.workspaceId, channelUrl, 'youtube', username, ws.campaignId]
  );
  await exec(
    "UPDATE discovery_results SET pipeline_job_id=?, status='queued' WHERE id=?",
    [pipelineJobId, resultId]
  );
  return pipelineJobId;
}

/** runPipeline stage 1 — scrape result lands in kol_database, stage → write. */
async function runScrapeStage({ pipelineJobId, username, channelUrl, email }) {
  const existing = await queryOne(
    'SELECT id FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
    [ws.workspaceId, 'youtube', username]
  );
  const kolDatabaseId = existing ? existing.id : uuid();
  await exec(
    `INSERT OR REPLACE INTO kol_database (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, following, engagement_rate, avg_views, total_videos, category, email, bio, country, language, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, CURRENT_TIMESTAMP)`,
    [kolDatabaseId, ws.workspaceId, 'youtube', username, username, '', channelUrl, 120_000, 0, 4.5, 40_000, 90,
      'Gaming', email, 'bio', 'US', 'en', 71, 'stubbed score', 16, ws.campaignId]
  );
  await exec(
    "UPDATE pipeline_jobs SET kol_database_id=?, scrape_result=?, email_to=?, stage='write', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [kolDatabaseId, JSON.stringify({ display_name: username, followers: 120_000, email }), email, pipelineJobId]
  );
  return kolDatabaseId;
}

/** runPipeline stage 2 — draft copy, kols + contacts rows, stage → review. */
async function runWriteStage({ pipelineJobId, kolDatabaseId, username, channelUrl, email }) {
  // Production calls generateOutreachEmail(), which tries llm.complete() and
  // silently falls back to this same template renderer. The LLM module is
  // stubbed above, so this stays deterministic either way.
  const rendered = renderEmail('outreach-affiliate-en', {
    kol_name: username,
    platform: 'youtube',
    followers: '120K',
    category: 'Gaming',
    sender_name: 'Integration Test',
    product_name: 'InfluenceX',
  });

  await exec(
    'UPDATE kol_database SET outreach_email_subject=?, outreach_email_body=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    [rendered.subject, rendered.body, kolDatabaseId]
  );

  const kolId = uuid();
  await exec(
    "INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, profile_url, bio, ai_score, ai_reason, estimated_cpm, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')",
    [kolId, ws.workspaceId, ws.campaignId, 'youtube', username, username, '', 120_000, 4.5, 40_000, 'Gaming', email, channelUrl, 'bio', 71, 'stubbed score', 16]
  );

  const contactId = uuid();
  await exec(
    "INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, status) VALUES (?, ?, ?, ?, ?, ?, 'affiliate', 'draft')",
    [contactId, ws.workspaceId, kolId, ws.campaignId, rendered.subject, rendered.body]
  );
  await exec(
    "UPDATE pipeline_jobs SET contact_id=?, email_subject=?, email_body=?, stage='review', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [contactId, rendered.subject, rendered.body, pipelineJobId]
  );
  return { kolId, contactId, rendered };
}

/** POST /api/pipeline/jobs/:id/approve — the scoped statements plus the enqueue. */
async function approve({ pipelineJobId, queue }) {
  const s = scoped(ws.workspaceId);
  const job = await s.queryOne(
    'SELECT * FROM pipeline_jobs WHERE id=? AND workspace_id=?',
    [pipelineJobId, ws.workspaceId]
  );
  assert.equal(job.stage, 'review', 'approve is only valid from the review stage');
  assert.ok(job.contact_id, 'approve requires a linked contact');

  await s.exec(
    "UPDATE pipeline_jobs SET email_approved=1, email_to=?, stage='send', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
    [job.email_to, job.id, ws.workspaceId]
  );
  await s.exec(
    "UPDATE contacts SET status='pending', send_error=NULL, email_subject=?, email_body=? WHERE id=? AND workspace_id=?",
    [job.email_subject, job.email_body, job.contact_id, ws.workspaceId]
  );
  const queueJobId = queue.push('email.send', { contactId: job.contact_id, toOverride: job.email_to }, { maxRetries: 3 });
  return { queueJobId, contactId: job.contact_id, emailTo: job.email_to };
}

/** Walk a fresh candidate all the way to "awaiting review". */
async function driveToReview(tag) {
  const username = `int_${tag}`;
  const email = `${username}@creators.example`;
  const discovery = await seedDiscoveryRun({ username });
  const pipelineJobId = await processDiscoveryResult({ ...discovery, username });
  const kolDatabaseId = await runScrapeStage({ pipelineJobId, username, channelUrl: discovery.channelUrl, email });
  const written = await runWriteStage({ pipelineJobId, kolDatabaseId, username, channelUrl: discovery.channelUrl, email });
  return { username, email, pipelineJobId, kolDatabaseId, ...discovery, ...written };
}

const getJob = id => queryOne('SELECT * FROM pipeline_jobs WHERE id = ?', [id]);
const getContact = id => queryOne('SELECT * FROM contacts WHERE id = ?', [id]);

// ===========================================================================

test('discovery → pipeline: the candidate becomes a review-stage job with a linked contact', async () => {
  const f = await driveToReview('link');

  const result = await queryOne('SELECT * FROM discovery_results WHERE id = ?', [f.resultId]);
  assert.equal(result.status, 'queued');
  assert.equal(result.pipeline_job_id, f.pipelineJobId);

  const job = await getJob(f.pipelineJobId);
  assert.equal(job.stage, 'review');
  assert.equal(job.source, 'discovery');
  assert.equal(job.workspace_id, ws.workspaceId);
  assert.equal(job.contact_id, f.contactId, 'pipeline_jobs.contact_id must link the draft');
  assert.equal(job.email_to, f.email);
  assert.ok(job.email_subject && job.email_body, 'write stage must persist the draft copy');

  const contact = await getContact(f.contactId);
  assert.equal(contact.status, 'draft');
  assert.equal(contact.workspace_id, ws.workspaceId);

  // The scraped row must be visible through a workspace-scoped read — the
  // regression behind E2E_REVIEW P0-3 (rows landing with workspace_id NULL).
  const s = scoped(ws.workspaceId);
  const visible = await s.query(
    'SELECT id, workspace_id FROM kol_database WHERE workspace_id = ? AND username = ?',
    [ws.workspaceId, f.username]
  );
  assert.equal(visible.rows.length, 1);
  assert.equal(visible.rows[0].workspace_id, ws.workspaceId);

  // No network was reachable: the stubbed LLM is the only completion path.
  assert.ok(Array.isArray(llmCalls));
});

test('approve → send: contact reaches sent and the pipeline job advances to monitor', async () => {
  const f = await driveToReview('happy');
  const mailAgent = makeMailAgent();
  const queue = makeQueue(mailAgent);

  const { queueJobId, contactId } = await approve({ pipelineJobId: f.pipelineJobId, queue });
  assert.equal(typeof queueJobId, 'number', 'in-process queue hands back a numeric job id');

  // Handoff state: approve moved both rows before the worker ran.
  assert.equal((await getJob(f.pipelineJobId)).stage, 'send');

  await queue.drain(5000);

  const contact = await getContact(contactId);
  assert.equal(contact.status, 'sent');
  assert.equal(contact.send_error, null);
  assert.ok(contact.sent_at, 'sent_at must be stamped');
  assert.equal(contact.send_attempts, 1);
  assert.equal(contact.provider_message_id, 'msg-1');

  const job = await getJob(f.pipelineJobId);
  assert.equal(job.stage, 'monitor', 'worker syncs the pipeline row after a real send');
  assert.equal(job.email_approved, 1);
  assert.equal(job.smtp_message_id, 'msg-1');
  assert.ok(job.email_sent_at);

  // The provider saw exactly one message, addressed from pipeline_jobs.email_to.
  assert.equal(mailAgent.sent.length, 1);
  assert.equal(mailAgent.sent[0].to, f.email);
  assert.equal(mailAgent.sent[0].subject, f.rendered.subject);

  const outbound = await query(
    "SELECT * FROM email_replies WHERE contact_id = ? AND direction = 'outbound'",
    [contactId]
  );
  assert.equal(outbound.rows.length, 1);
  assert.equal(outbound.rows[0].workspace_id, ws.workspaceId);

  const events = await query('SELECT event_type FROM email_events WHERE contact_id = ?', [contactId]);
  assert.deepEqual(events.rows.map(e => e.event_type), ['sent']);

  assert.equal(queue.getStats().failed, 0);
});

test('no mail provider configured: dry-run completes the whole flow without calling out', async () => {
  // This test used to pin the opposite: the dry-run branch returned early,
  // *before* the pipeline_jobs sync, so a provider-less deployment (which is
  // what CI is, and what a fresh self-host is) left every approved job
  // stranded at stage='send' — the contact said "sent" while the Pipeline
  // page showed it stuck mid-flight forever. The branch now skips only the
  // provider call; all bookkeeping below it runs.
  const f = await driveToReview('dryrun');
  const mailAgent = makeMailAgent({ configured: false });
  const queue = makeQueue(mailAgent);

  const { contactId } = await approve({ pipelineJobId: f.pipelineJobId, queue });
  await queue.drain(5000);

  const contact = await getContact(contactId);
  assert.equal(contact.status, 'sent');
  assert.ok(contact.sent_at);
  assert.equal(contact.provider_message_id, null, 'nothing was sent, so there is no provider id');

  const job = await getJob(f.pipelineJobId);
  assert.equal(job.stage, 'monitor', 'the job must not be stranded at send');
  assert.ok(job.email_sent_at, 'pipeline row records when the flow completed');
  assert.equal(job.smtp_message_id, null);

  assert.equal(mailAgent.sent.length, 0, 'no provider call may happen in dry-run mode');

  // The thread row and the event exist so the UI isn't blank, and the event
  // is labelled so nobody mistakes a dry run for a real delivery.
  const thread = await query(
    "SELECT direction, to_email FROM email_replies WHERE contact_id = ?", [contactId]
  );
  assert.equal(thread.rows.length, 1);
  assert.equal(thread.rows[0].direction, 'outbound');

  const events = await query(
    'SELECT event_type, payload FROM email_events WHERE contact_id = ?', [contactId]
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].event_type, 'sent');
  assert.equal(JSON.parse(events.rows[0].payload || '{}').dryRun, true);
});

test('terminal provider failure: contact fails and the pipeline job bounces back to review', async () => {
  const f = await driveToReview('terminal');
  const mailAgent = makeMailAgent({
    result: () => ({ success: false, error: 'Invalid recipient (422)' }),
  });
  const queue = makeQueue(mailAgent);

  const { contactId } = await approve({ pipelineJobId: f.pipelineJobId, queue });
  await queue.drain(5000);

  const contact = await getContact(contactId);
  assert.equal(contact.status, 'failed');
  assert.match(contact.send_error, /Invalid recipient/);

  const job = await getJob(f.pipelineJobId);
  assert.equal(job.stage, 'review', 'a terminal failure must be re-editable by the admin');
  assert.match(job.error, /Invalid recipient/);

  const events = await query('SELECT event_type FROM email_events WHERE contact_id = ?', [contactId]);
  assert.deepEqual(events.rows.map(e => e.event_type), ['failed']);
  // Terminal errors are not retried.
  assert.equal(mailAgent.sent.length, 1);
});

test('transient provider failure: the queue retries and the job stays at send until it succeeds', async () => {
  const f = await driveToReview('transient');
  const mailAgent = makeMailAgent({
    result: (_payload, n) => (n === 1
      ? { success: false, error: 'socket hang up' }
      : { success: true, messageId: 'msg-retry', provider: 'stub' }),
  });
  const queue = createQueue({ concurrency: 1, defaultMaxRetries: 3, baseBackoffMs: 5 });
  emailJobs.register({ jobQueue: queue, query, queryOne, exec, mailAgent });

  const { contactId } = await approve({ pipelineJobId: f.pipelineJobId, queue });
  await queue.drain(5000);

  assert.equal(mailAgent.sent.length, 2, 'transient failures are retried by the queue');
  assert.equal(queue.getStats().retried, 1);

  const contact = await getContact(contactId);
  assert.equal(contact.status, 'sent');
  assert.equal(contact.provider_message_id, 'msg-retry');
  assert.equal(contact.send_attempts, 2);

  assert.equal((await getJob(f.pipelineJobId)).stage, 'monitor');
});

test('double approve does not double-send: the second job is skipped by the atomic claim', async () => {
  const f = await driveToReview('idempotent');
  const mailAgent = makeMailAgent();
  const queue = makeQueue(mailAgent);

  const { contactId, emailTo } = await approve({ pipelineJobId: f.pipelineJobId, queue });
  await queue.drain(5000);
  assert.equal((await getContact(contactId)).status, 'sent');

  // A redelivered enqueue for the same contact — what a double-click or a
  // BullMQ redelivery looks like.
  queue.push('email.send', { contactId, toOverride: emailTo }, { maxRetries: 1 });
  await queue.drain(5000);

  assert.equal(mailAgent.sent.length, 1, 'the KOL must not receive a second outreach email');
  assert.equal((await getContact(contactId)).send_attempts, 1);
  assert.equal(queue.getStats().failed, 0);
});

test('email.sync_status sweeps a contact stranded in pending back to failed', async () => {
  const f = await driveToReview('sweep');
  const mailAgent = makeMailAgent();
  const queue = makeQueue(mailAgent);

  // Approve without letting the worker run, then age the row past the cutoff.
  const s = scoped(ws.workspaceId);
  await s.exec(
    "UPDATE contacts SET status='pending', send_error=NULL WHERE id=? AND workspace_id=?",
    [f.contactId, ws.workspaceId]
  );
  await exec(
    'UPDATE contacts SET last_send_attempt_at = ? WHERE id = ?',
    [new Date(Date.now() - 60 * 60 * 1000).toISOString(), f.contactId]
  );

  queue.push('email.sync_status', {}, { maxRetries: 0 });
  await queue.drain(5000);

  const contact = await getContact(f.contactId);
  assert.equal(contact.status, 'failed');
  assert.match(contact.send_error, /Timed out waiting for send/);
  assert.equal(mailAgent.sent.length, 0);
});
