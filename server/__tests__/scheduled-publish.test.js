const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processDue } = require('../scheduled-publish');

// Minimal in-memory fake DB: the processor only touches scheduled_publishes
// and platform_connections, so we mock just those two tables.
function makeFakeDb({ scheduledRows = [], connections = [] } = {}) {
  const updates = [];
  const state = {
    scheduled: scheduledRows.map(r => ({ ...r })),
    connections: connections.map(c => ({ ...c })),
    updates,
  };
  async function query(sql, params) {
    if (/FROM scheduled_publishes/i.test(sql) && /status = 'pending'/.test(sql)) {
      const now = params[0];
      return { rows: state.scheduled.filter(r => r.status === 'pending' && r.scheduled_at <= now) };
    }
    return { rows: [] };
  }
  async function queryOne(sql, params) {
    if (/FROM platform_connections/i.test(sql)) {
      const [ws, platform] = params;
      return state.connections.find(c => c.workspace_id === ws && c.platform === platform) || null;
    }
    return null;
  }
  async function exec(sql, params = []) {
    updates.push({ sql, params });
    if (/UPDATE scheduled_publishes SET status='running'/.test(sql)) {
      const row = state.scheduled.find(r => r.id === params[0]);
      if (row) { row.status = 'running'; row.attempts = (row.attempts || 0) + 1; }
    } else if (/UPDATE scheduled_publishes SET status='error'/.test(sql)) {
      const row = state.scheduled.find(r => r.id === params[1]);
      if (row) { row.status = 'error'; row.result = params[0]; }
    } else if (/UPDATE scheduled_publishes SET status='complete'/.test(sql)) {
      const row = state.scheduled.find(r => r.id === params[1]);
      if (row) { row.status = 'complete'; row.result = params[0]; }
    }
    return { rowCount: 1 };
  }
  return { state, query, queryOne, exec };
}

function makePublishOauth({ publishImpl }) {
  return {
    getProvider: (name) => ({ id: name, kind: 'oauth' }),
    publishDirect: async (platform, creds, payload) => publishImpl(platform, creds, payload),
  };
}

const dummyAgentRuntime = { createRun: () => ({ stream: { on: () => {} } }) };
const dummyNotifications = { notify: () => {} };
const nowIso = new Date().toISOString();

test('direct mode: posts to every platform and marks complete when at least one succeeds', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-1', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      platforms: JSON.stringify(['twitter', 'linkedin']),
      content_snapshot: JSON.stringify({ title: 't', body: 'hello world', type: 'text' }),
    }],
    connections: [
      { id: 'c1', workspace_id: 'ws-1', platform: 'twitter', access_token: 'tok-tw' },
      { id: 'c2', workspace_id: 'ws-1', platform: 'linkedin', access_token: 'tok-li' },
    ],
  });
  const calls = [];
  const publishOauth = makePublishOauth({
    publishImpl: async (platform, creds) => {
      calls.push({ platform, creds });
      if (platform === 'twitter') return { success: true, platform_post_id: '123', url: 'https://x.com/i/status/123' };
      return { success: false, error: 'linkedin down' };
    },
  });

  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'fake-uuid', publishOauth, agentRuntime: dummyAgentRuntime, notifications: dummyNotifications,
  });

  assert.equal(r.processed, 1);
  assert.equal(r.ok, 1);
  assert.equal(r.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].creds, 'tok-tw');
  const row = db.state.scheduled[0];
  assert.equal(row.status, 'complete');
  const saved = JSON.parse(row.result);
  assert.equal(saved.mode, 'direct');
  assert.equal(saved.results.length, 2);
  assert.equal(saved.results[0].success, true);
  assert.equal(saved.results[1].success, false);
});

test('direct mode: marks row as error when every platform fails', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-2', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: nowIso,
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'test', type: 'text' }),
    }],
    connections: [{ id: 'c1', workspace_id: 'ws-1', platform: 'twitter', access_token: 'tok' }],
  });
  const publishOauth = makePublishOauth({
    publishImpl: async () => ({ success: false, error: 'rate limited' }),
  });

  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth, agentRuntime: dummyAgentRuntime, notifications: dummyNotifications,
  });

  assert.equal(r.failed, 1);
  assert.equal(db.state.scheduled[0].status, 'error');
  const saved = JSON.parse(db.state.scheduled[0].result);
  assert.ok(/twitter: rate limited/.test(saved.error));
});

test('direct mode: missing platform_connection records a per-platform error without crashing', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-3', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: nowIso,
      platforms: JSON.stringify(['medium']),
      content_snapshot: JSON.stringify({ body: 'hi', type: 'text' }),
    }],
    connections: [], // no connection for medium
  });
  const publishOauth = makePublishOauth({ publishImpl: async () => { throw new Error('should not be called'); } });

  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth, agentRuntime: dummyAgentRuntime, notifications: dummyNotifications,
  });

  assert.equal(r.failed, 1);
  const saved = JSON.parse(db.state.scheduled[0].result);
  assert.ok(/medium not connected/.test(saved.error));
});

test('empty queue returns zero-work result', async () => {
  const db = makeFakeDb();
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth: makePublishOauth({ publishImpl: async () => ({}) }),
    agentRuntime: dummyAgentRuntime, notifications: dummyNotifications,
  });
  assert.deepEqual(r, { processed: 0, ok: 0, failed: 0 });
});

test('intent mode: routes through publisher agent and marks complete', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-4', workspace_id: 'ws-1', mode: 'intent', status: 'pending',
      scheduled_at: nowIso,
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'intent test', type: 'text' }),
    }],
  });
  // Fake agent runtime that emits complete then closed synchronously.
  const fakeRuntime = {
    createRun: () => {
      const listeners = [];
      const stream = { on: (evt, cb) => { if (evt === 'event') listeners.push(cb); } };
      setImmediate(() => {
        for (const cb of listeners) {
          cb({ type: 'complete', data: { output: { results: [{ platform: 'twitter', intent_url: 'https://x/intent' }] } } });
          cb({ type: 'closed', data: {} });
        }
      });
      return { runId: 'r1', stream };
    },
  };
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth: makePublishOauth({ publishImpl: async () => ({}) }),
    agentRuntime: fakeRuntime, notifications: dummyNotifications,
  });
  assert.equal(r.ok, 1);
  assert.equal(db.state.scheduled[0].status, 'complete');
});
