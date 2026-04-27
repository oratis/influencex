const { test } = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../kol-profile-cache');

function fakeDb() {
  const rows = new Map(); // key -> row
  return {
    queryOne: async (sql, params) => {
      // Match on (platform, username) which are 2nd + 3rd params.
      const [platform, username] = params;
      const key = `${platform}:${username}`;
      return rows.get(key) || null;
    },
    exec: async (sql, params) => {
      if (/^DELETE FROM kol_profile_cache WHERE id/i.test(sql)) {
        const [id] = params;
        for (const [k, v] of rows.entries()) {
          if (v.id === id) rows.delete(k);
        }
        return;
      }
      if (/^DELETE FROM kol_profile_cache/i.test(sql)) {
        const [platform, username] = params;
        const key = `${platform}:${username}`;
        rows.delete(key);
        return;
      }
      if (/^INSERT INTO kol_profile_cache/i.test(sql)) {
        const [id, platform, username, profile_data, source, expires_at] = params;
        rows.set(`${platform}:${username}`, { id, platform, username, profile_data, source, expires_at });
        return;
      }
    },
    _rows: rows,
  };
}

test('lookup: returns null on cache miss', async () => {
  const db = fakeDb();
  const r = await cache.lookup(db, 'instagram', 'demo');
  assert.equal(r, null);
});

test('put + lookup: round-trip', async () => {
  const db = fakeDb();
  await cache.put(db, 'instagram', 'demo', { followers: 999, display_name: 'Demo' });
  const r = await cache.lookup(db, 'instagram', 'demo');
  assert.ok(r);
  assert.equal(r.data.followers, 999);
  assert.equal(r.source, 'apify');
});

test('lookup: case-insensitive on platform + username', async () => {
  const db = fakeDb();
  await cache.put(db, 'Instagram', '@DemoUser', { followers: 100 });
  const r = await cache.lookup(db, 'instagram', 'demouser');
  assert.ok(r);
  assert.equal(r.data.followers, 100);
});

test('put: overrides existing entry (delete-then-insert)', async () => {
  const db = fakeDb();
  await cache.put(db, 'tiktok', 'foo', { followers: 1 });
  await cache.put(db, 'tiktok', 'foo', { followers: 999 });
  const r = await cache.lookup(db, 'tiktok', 'foo');
  assert.equal(r.data.followers, 999);
});

test('lookup: returns null + reaps when expired', async () => {
  const db = fakeDb();
  // Inject an expired row by hand
  const past = new Date(Date.now() - 1000).toISOString();
  db._rows.set('tiktok:expired', {
    id: 'r1', platform: 'tiktok', username: 'expired',
    profile_data: '{"followers":5}', source: 'apify', expires_at: past,
  });
  const r = await cache.lookup(db, 'tiktok', 'expired');
  assert.equal(r, null);
  assert.equal(db._rows.size, 0); // reaped
});

test('evict: removes specific entry', async () => {
  const db = fakeDb();
  await cache.put(db, 'instagram', 'a', { followers: 1 });
  await cache.put(db, 'instagram', 'b', { followers: 2 });
  await cache.evict(db, 'instagram', 'a');
  assert.equal(await cache.lookup(db, 'instagram', 'a'), null);
  assert.ok(await cache.lookup(db, 'instagram', 'b'));
});

test('lookup: missing table → returns null gracefully', async () => {
  const db = {
    queryOne: async () => { throw new Error('no such table: kol_profile_cache'); },
    exec: async () => {},
  };
  const r = await cache.lookup(db, 'instagram', 'foo');
  assert.equal(r, null);
});
