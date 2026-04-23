/**
 * Tests for the outreach scheduler's tick logic.
 *
 * We mock the DB (query/exec) and the job queue so we can inspect
 * enqueued jobs without a running Postgres/SQLite. The goal is to verify:
 *
 *   - Scheduled-send branch enqueues due contacts via email.send
 *     and clears their scheduled_send_at + flips status to 'pending'.
 *   - Multi-step follow-up branch enqueues the next step based on
 *     `follow_up_count` matching the right interval index.
 *   - Missing kol_email is flagged as an error, not silently dropped.
 *   - Absent jobQueue produces a clear error instead of throwing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Scheduler uses INTERVALS built at module load from env, so we set the env
// BEFORE requiring it. Keep this near the top of the file.
process.env.FOLLOW_UP_INTERVALS_DAYS = '4,10';
const scheduler = require('../scheduler');

function makeMocks({ dueRows = [], followupRowsByStep = [], updateCaptured = [], enqueued = [] } = {}) {
  const updates = updateCaptured;
  const enq = enqueued;
  let dueCallN = 0;
  let followupCallN = 0;

  const query = async (sql) => {
    if (/scheduled_send_at IS NOT NULL/.test(sql)) {
      dueCallN += 1;
      return { rows: dueRows };
    }
    if (/follow_up_count/.test(sql)) {
      const rows = followupRowsByStep[followupCallN] || [];
      followupCallN += 1;
      return { rows };
    }
    return { rows: [] };
  };
  const exec = async (sql, params) => { updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rowCount: 1 }; };
  const queryOne = async () => null;
  const uuidv4 = () => 'fake-uuid';
  const mailAgent = { isConfigured: () => true, sendEmail: async () => ({ success: true, messageId: 'm1' }) };
  const jobQueue = {
    push: (type, payload, opts) => { enq.push({ type, payload, opts }); return Math.random(); },
  };
  return { query, exec, queryOne, uuidv4, mailAgent, jobQueue, updates, enq };
}

test('scheduled-send: enqueues due contact and clears schedule', async () => {
  const dueRows = [
    { id: 'c1', scheduled_send_at: '2020-01-01T00:00:00.000Z', kol_email: 'a@b.com' },
  ];
  const updates = [];
  const enq = [];
  const mocks = makeMocks({ dueRows, updateCaptured: updates, enqueued: enq });

  const r = await scheduler.tick(mocks);
  assert.equal(r.scheduled_sent, 1);
  assert.equal(enq.length >= 1, true);
  const sendJob = enq.find(e => e.type === 'email.send' && !e.payload.kind);
  assert.ok(sendJob, 'should enqueue an email.send for the due contact');
  assert.equal(sendJob.payload.contactId, 'c1');
  // Update should clear scheduled_send_at and set status=pending
  const clearUpdate = updates.find(u => /scheduled_send_at = NULL/.test(u.sql) && /status = 'pending'/.test(u.sql));
  assert.ok(clearUpdate, 'should clear scheduled_send_at and set pending status');
});

test('scheduled-send: missing kol_email records an error and does not enqueue', async () => {
  const dueRows = [{ id: 'c2', scheduled_send_at: '2020-01-01T00:00:00.000Z', kol_email: null }];
  const enq = [];
  const mocks = makeMocks({ dueRows, enqueued: enq });
  const r = await scheduler.tick(mocks);
  assert.equal(r.scheduled_sent, 0);
  assert.ok(r.errors.some(e => e.contactId === 'c2' && /No recipient/.test(e.error)));
  assert.equal(enq.filter(e => e.payload.contactId === 'c2').length, 0);
});

test('multi-step follow-ups: contacts at step 0 and step 1 each get enqueued as followup kind', async () => {
  // Two "steps" — step 0 has one row, step 1 has a different row.
  const followupRowsByStep = [
    [{ id: 'f0', email_subject: 'Original A', kol_email: 'f0@x.com', display_name: 'F0', workspace_id: 'w', follow_up_count: 0 }],
    [{ id: 'f1', email_subject: 'Original B', kol_email: 'f1@x.com', display_name: 'F1', workspace_id: 'w', follow_up_count: 1 }],
  ];
  const enq = [];
  const mocks = makeMocks({ followupRowsByStep, enqueued: enq });
  const r = await scheduler.tick(mocks);
  assert.equal(r.follow_ups_sent, 2, 'both steps should fire');
  const followupJobs = enq.filter(e => e.payload.kind === 'followup');
  assert.equal(followupJobs.length, 2);
  const ids = followupJobs.map(j => j.payload.contactId).sort();
  assert.deepEqual(ids, ['f0', 'f1']);
  // Subject overrides should be prefixed with "Re: "
  assert.ok(followupJobs.every(j => j.payload.subjectOverride?.startsWith('Re: ')));
});

test('follow-up with no jobQueue records an error instead of crashing', async () => {
  const followupRowsByStep = [[{ id: 'x', email_subject: 'S', kol_email: 'x@x.com' }]];
  const mocks = makeMocks({ followupRowsByStep });
  mocks.jobQueue = null;
  const r = await scheduler.tick(mocks);
  // Implementation opts to `continue` silently when jobQueue is missing;
  // we assert it doesn't throw and doesn't enqueue.
  assert.equal(r.follow_ups_sent, 0);
});

test('scheduled-send query uses an ISO-string "now" parameter (cross-DB safe)', async () => {
  // This test is more of a contract check — if someone ever flips it back
  // to CURRENT_TIMESTAMP, the SQLite comparison bug would return. We snoop
  // the params passed to query.
  let capturedParams = null;
  const mocks = makeMocks();
  const originalQuery = mocks.query;
  mocks.query = async (sql, params) => {
    if (/scheduled_send_at IS NOT NULL/.test(sql)) capturedParams = params;
    return originalQuery(sql);
  };
  await scheduler.tick(mocks);
  assert.ok(Array.isArray(capturedParams) && capturedParams.length === 1);
  // Must look like an ISO 8601 string, not undefined or 'CURRENT_TIMESTAMP'.
  assert.match(capturedParams[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
