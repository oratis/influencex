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
      // Return shallow copies so caller can't observe mid-flight mutations
      // made by subsequent UPDATEs — a real DB returns values, not refs.
      return {
        rows: state.scheduled
          .filter(r => {
            if (r.status !== 'pending') return false;
            const effective = r.next_retry_at || r.scheduled_at;
            return effective <= now;
          })
          .map(r => ({ ...r })),
      };
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
    } else if (/UPDATE scheduled_publishes SET status='pending'/.test(sql)) {
      // Retry path: status=pending, next_retry_at=?, error_message=?, result=? WHERE id=?
      const row = state.scheduled.find(r => r.id === params[3]);
      if (row) {
        row.status = 'pending';
        row.next_retry_at = params[0];
        row.error_message = params[1];
        row.result = params[2];
      }
    } else if (/UPDATE scheduled_publishes SET status='error'/.test(sql)) {
      // Two shapes: 4 params (result, error_message, id + completed_at literal)
      // and 3 params (result, error_message, id). Find id by last param.
      const id = params[params.length - 1];
      const row = state.scheduled.find(r => r.id === id);
      if (row) { row.status = 'error'; row.result = params[0]; row.error_message = params[1]; }
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

// Fake agent runtime that mirrors what the real publisher agent does. For
// direct mode it uses the injected publishOauth fake to simulate per-platform
// results; for intent mode it returns a trivial intent-url package. This is
// what the processor talks to now (collapsed to one agent regardless of mode).
function makeFakePublisherRuntime({ publishOauth, queryOne } = {}) {
  return {
    createRun: (agentId, input, ctx) => {
      const listeners = [];
      const stream = { on: (evt, cb) => { if (evt === 'event') listeners.push(cb); } };
      const emit = (evt) => { for (const cb of listeners) cb(evt); };
      const run = async () => {
        try {
          let output;
          if (input.mode === 'direct') {
            const results = [];
            for (const platform of input.platforms) {
              const conn = await queryOne(
                'SELECT * FROM platform_connections WHERE workspace_id = ? AND platform = ?',
                [ctx.workspaceId, platform]
              );
              if (!conn) {
                results.push({ platform, success: false, error: `${platform} not connected for this workspace` });
                continue;
              }
              try {
                const r = await publishOauth.publishDirect(platform, conn.access_token, {
                  text: input.content.body || input.content.title || '',
                });
                results.push({ platform, ...r });
              } catch (e) {
                results.push({ platform, success: false, error: e.message });
              }
            }
            output = { mode: 'direct', results };
          } else {
            output = { mode: 'intent', results: input.platforms.map(p => ({ platform: p, intent_url: `https://${p}/intent` })) };
          }
          emit({ type: 'complete', data: { output } });
          emit({ type: 'closed', data: {} });
        } catch (e) {
          emit({ type: 'error', data: { message: e.message } });
          emit({ type: 'closed', data: {} });
        }
      };
      setImmediate(run);
      return { runId: 'r1', stream };
    },
  };
}

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
    uuidv4: () => 'fake-uuid', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
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

test('direct mode: marks row as error when every platform fails with non-retryable error', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-2', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: nowIso, max_attempts: 3,
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'test', type: 'text' }),
    }],
    connections: [{ id: 'c1', workspace_id: 'ws-1', platform: 'twitter', access_token: 'tok' }],
  });
  // Non-retryable — malformed request won't succeed on a second attempt.
  const publishOauth = makePublishOauth({
    publishImpl: async () => ({ success: false, error: 'Bad Request: malformed payload' }),
  });

  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
  });

  assert.equal(r.failed, 1);
  assert.equal(db.state.scheduled[0].status, 'error', 'non-retryable error should end in error status');
  const saved = JSON.parse(db.state.scheduled[0].result);
  assert.ok(/twitter:.*malformed/.test(saved.error));
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
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
  });

  assert.equal(r.failed, 1);
  const saved = JSON.parse(db.state.scheduled[0].result);
  assert.ok(/medium not connected/.test(saved.error));
});

test('empty queue returns zero-work result', async () => {
  const db = makeFakeDb();
  const publishOauth = makePublishOauth({ publishImpl: async () => ({}) });
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
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

// --- Retry-with-backoff tests ---------------------------------------------

const { isRetryable, nextRetryDelayMs } = require('../scheduled-publish');

test('isRetryable: transient signals return true, input errors return false', () => {
  // Retryable
  assert.equal(isRetryable('rate limited'), true);
  assert.equal(isRetryable('Too Many Requests'), true);
  assert.equal(isRetryable('Twitter API 429: ...'), true);
  assert.equal(isRetryable('LinkedIn API 503: upstream down'), true);
  assert.equal(isRetryable('fetch failed: ETIMEDOUT'), true);
  assert.equal(isRetryable('ECONNRESET'), true);
  // Not retryable
  assert.equal(isRetryable('Bad Request: missing image_url'), false);
  assert.equal(isRetryable('medium not connected for this workspace'), false);
  assert.equal(isRetryable('Reddit: title is required'), false);
  assert.equal(isRetryable(''), false);
  assert.equal(isRetryable(null), false);
});

test('nextRetryDelayMs: 2min → 10min → 30min → 120min cap', () => {
  assert.equal(nextRetryDelayMs(1), 2 * 60_000);
  assert.equal(nextRetryDelayMs(2), 10 * 60_000);
  assert.equal(nextRetryDelayMs(3), 30 * 60_000);
  assert.equal(nextRetryDelayMs(4), 120 * 60_000);
  assert.equal(nextRetryDelayMs(99), 120 * 60_000); // capped
});

test('direct mode: transient failure reschedules row as pending with next_retry_at', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-retry-1', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: nowIso, max_attempts: 3, attempts: 0,
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'hi', type: 'text' }),
    }],
    connections: [{ id: 'c1', workspace_id: 'ws-1', platform: 'twitter', access_token: 'tok' }],
  });
  const publishOauth = makePublishOauth({
    publishImpl: async () => ({ success: false, error: 'Twitter API 429: rate limited' }),
  });

  const beforeTick = Date.now();
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
  });

  assert.equal(r.failed, 1, 'counted as failed for this tick');
  const row = db.state.scheduled[0];
  assert.equal(row.status, 'pending', 'row should stay pending for retry');
  assert.ok(row.next_retry_at, 'next_retry_at must be set');
  const retryAtMs = new Date(row.next_retry_at).getTime();
  // First retry uses the 2-minute schedule. Allow ±5s jitter for test timing.
  assert.ok(retryAtMs - beforeTick >= 2 * 60_000 - 5000, 'next_retry_at should be ≥ 2min away');
  assert.ok(retryAtMs - beforeTick <= 2 * 60_000 + 5000, 'next_retry_at should be ≤ 2min+jitter');
  assert.match(row.error_message, /rate limited/);
});

test('direct mode: retryable failure at max_attempts flips row to error', async () => {
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-retry-final', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: nowIso, max_attempts: 3, attempts: 2, // one more attempt to hit the cap
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'hi', type: 'text' }),
    }],
    connections: [{ id: 'c1', workspace_id: 'ws-1', platform: 'twitter', access_token: 'tok' }],
  });
  const publishOauth = makePublishOauth({
    publishImpl: async () => ({ success: false, error: 'Twitter API 429: still rate limited' }),
  });
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
  });
  assert.equal(r.failed, 1);
  const row = db.state.scheduled[0];
  assert.equal(row.status, 'error', 'should flip to error once attempts ≥ max_attempts');
  const saved = JSON.parse(row.result);
  assert.equal(saved.final_attempt, 3);
});

test('direct mode: row with next_retry_at in the future is NOT picked up', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const db = makeFakeDb({
    scheduledRows: [{
      id: 'sp-future', workspace_id: 'ws-1', mode: 'direct', status: 'pending',
      scheduled_at: new Date(Date.now() - 300_000).toISOString(),
      next_retry_at: future,
      platforms: JSON.stringify(['twitter']),
      content_snapshot: JSON.stringify({ body: 'hi', type: 'text' }),
    }],
  });
  const publishOauth = makePublishOauth({ publishImpl: async () => ({}) });
  const r = await processDue({
    query: db.query, queryOne: db.queryOne, exec: db.exec,
    uuidv4: () => 'x', publishOauth,
    agentRuntime: makeFakePublisherRuntime({ publishOauth, queryOne: db.queryOne }),
    notifications: dummyNotifications,
  });
  assert.deepEqual(r, { processed: 0, ok: 0, failed: 0 });
  assert.equal(db.state.scheduled[0].status, 'pending', 'row should remain pending');
});
