/**
 * Tests for email-jobs queue handlers.
 *
 * The handlers take (query, queryOne, exec, mailAgent, notifications, jobQueue)
 * as injected deps via register(), so we can drive them with simple in-memory
 * stand-ins. We assert:
 *
 *   - email.send happy path updates status=sent, writes email_replies row,
 *     records a 'sent' email_events entry.
 *   - email.send with kind='followup' bumps follow_up_count instead of
 *     regressing status, and allows subject/body overrides.
 *   - email.send with provider failure classified as terminal flips status
 *     to 'failed' and returns {failed:true} without throwing.
 *   - email.send with provider failure classified as transient re-throws
 *     so the queue retries (status stays 'pending').
 *   - Already-sent contact is skipped (short-circuit).
 *   - email.batch_send spreads one child email.send per contact id.
 *   - email.sync_status flips stuck-pending contacts to failed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// We need secrets.encrypt to work — set a test key.
process.env.MAILBOX_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const emailJobs = require('../email-jobs');

function makeFakeQueue() {
  const handlers = {};
  const pushed = [];
  return {
    register: (type, h) => { handlers[type] = h; },
    push: (type, payload, opts) => { pushed.push({ type, payload, opts }); return pushed.length; },
    run: (type, payload) => handlers[type]({ payload }),
    handlers, pushed,
  };
}

function makeDeps(overrides = {}) {
  const exec = async () => ({ rowCount: 1 });
  const query = async () => ({ rows: [] });
  const queryOne = async () => null;
  const mailAgent = { isConfigured: () => true, sendEmail: async () => ({ success: true, messageId: 'mid-1', provider: 'resend' }) };
  const notifications = { events: { emailSent: () => {} } };
  const jobQueue = makeFakeQueue();
  const deps = { exec, query, queryOne, mailAgent, notifications, jobQueue };
  return Object.assign(deps, overrides);
}

test('email.send: happy path marks sent + records reply + records event', async () => {
  const execCalls = [];
  const deps = makeDeps({
    queryOne: async (sql, params) => {
      if (/FROM contacts c JOIN kols/.test(sql) && params[0] === 'c1') {
        return { id: 'c1', kol_email: 'to@x.com', email_subject: 'S', email_body: 'B', status: 'draft', workspace_id: 'w1', display_name: 'Name' };
      }
      // default mailbox fetch
      if (/mailbox_accounts/.test(sql)) return null;
      return null;
    },
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 1 }; },
  });
  emailJobs.register(deps);
  const res = await deps.jobQueue.run('email.send', { contactId: 'c1' });
  assert.equal(res.success, true);
  assert.equal(res.messageId, 'mid-1');
  // Expect at least: send_attempts bump, status=sent update, email_replies insert, email_events insert
  assert.ok(execCalls.some(c => /status='sent'/.test(c.sql)), 'should flip status to sent');
  assert.ok(execCalls.some(c => /INSERT INTO email_replies/.test(c.sql)), 'should record outbound reply');
  assert.ok(execCalls.some(c => /INSERT INTO email_events/.test(c.sql)), 'should record sent event');
});

test('email.send with kind=followup bumps follow_up_count, does not flip status', async () => {
  const execCalls = [];
  const deps = makeDeps({
    queryOne: async (sql) => {
      if (/FROM contacts c JOIN kols/.test(sql)) {
        return { id: 'c2', kol_email: 'to@x.com', email_subject: 'Orig', email_body: 'B', status: 'sent', workspace_id: 'w', follow_up_count: 0 };
      }
      return null;
    },
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 1 }; },
  });
  emailJobs.register(deps);
  await deps.jobQueue.run('email.send', {
    contactId: 'c2',
    subjectOverride: 'Re: Orig',
    bodyOverride: 'Follow up body',
    kind: 'followup',
  });
  assert.ok(execCalls.some(c => /follow_up_count = COALESCE\(follow_up_count, 0\) \+ 1/.test(c.sql)), 'follow_up_count should bump');
  assert.ok(!execCalls.some(c => /status='sent'/.test(c.sql)), 'should NOT re-flip to sent');
  // email_replies should record the override body/subject
  const reply = execCalls.find(c => /INSERT INTO email_replies/.test(c.sql));
  assert.ok(reply);
  assert.ok(reply.params.some(p => p === 'Re: Orig'));
  assert.ok(reply.params.some(p => p === 'Follow up body'));
});

test('email.send: already sent contact is short-circuited when not followup', async () => {
  const execCalls = [];
  const deps = makeDeps({
    queryOne: async () => ({ id: 'c3', kol_email: 't@x', email_subject: 'S', email_body: 'B', status: 'delivered', workspace_id: 'w' }),
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 1 }; },
  });
  emailJobs.register(deps);
  const r = await deps.jobQueue.run('email.send', { contactId: 'c3' });
  assert.match(r.skipped || '', /already/);
  assert.equal(execCalls.length, 0, 'no DB writes for short-circuited send');
});

test('email.send: terminal provider error flips status=failed, returns without throwing', async () => {
  const execCalls = [];
  const deps = makeDeps({
    queryOne: async (sql) => {
      if (/FROM contacts c JOIN kols/.test(sql)) {
        return { id: 'c4', kol_email: 't@x', email_subject: 'S', email_body: 'B', status: 'pending', workspace_id: 'w' };
      }
      return null;
    },
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 1 }; },
    mailAgent: { isConfigured: () => true, sendEmail: async () => ({ success: false, error: 'API key is invalid' }) },
  });
  emailJobs.register(deps);
  const res = await deps.jobQueue.run('email.send', { contactId: 'c4' });
  assert.equal(res.failed, true);
  assert.ok(execCalls.some(c => /status = \?/.test(c.sql) && c.params.includes('failed')));
});

test('email.send: transient provider error throws so queue retries', async () => {
  const deps = makeDeps({
    queryOne: async () => ({ id: 'c5', kol_email: 't@x', email_subject: 'S', email_body: 'B', status: 'pending', workspace_id: 'w' }),
    mailAgent: { isConfigured: () => true, sendEmail: async () => ({ success: false, error: 'timeout connecting to upstream' }) },
  });
  emailJobs.register(deps);
  await assert.rejects(() => deps.jobQueue.run('email.send', { contactId: 'c5' }), /timeout/);
});

test('email.send: missing recipient → status=failed, terminal', async () => {
  const execCalls = [];
  const deps = makeDeps({
    queryOne: async () => ({ id: 'c6', kol_email: null, email_subject: 'S', email_body: 'B', status: 'pending', workspace_id: 'w' }),
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 1 }; },
  });
  emailJobs.register(deps);
  const res = await deps.jobQueue.run('email.send', { contactId: 'c6' });
  assert.equal(res.failed, true);
  assert.equal(res.error, 'no recipient');
  // The no-recipient branch writes status='failed' as a SQL literal.
  assert.ok(execCalls.some(c => /status='failed'/.test(c.sql) && /No recipient email/.test(c.sql)));
});

test('email.batch_send: enqueues one email.send per contact id', async () => {
  const deps = makeDeps();
  emailJobs.register(deps);
  await deps.jobQueue.run('email.batch_send', { contactIds: ['a', 'b', 'c'] });
  const children = deps.jobQueue.pushed.filter(p => p.type === 'email.send');
  assert.equal(children.length, 3);
  assert.deepEqual(children.map(c => c.payload.contactId).sort(), ['a', 'b', 'c']);
});

test('email.sync_status: clears stuck-pending rows', async () => {
  const execCalls = [];
  const deps = makeDeps({
    exec: async (sql, params) => { execCalls.push({ sql, params }); return { rowCount: 2 }; },
  });
  emailJobs.register(deps);
  const r = await deps.jobQueue.run('email.sync_status', {});
  assert.equal(r.cleared, 2);
  assert.ok(execCalls.some(c => /status = 'failed'/.test(c.sql) && /status = 'pending'/.test(c.sql)));
});
