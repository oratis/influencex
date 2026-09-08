/**
 * Capability matrix + manifest + connector contract invariants for
 * packages/social-ops. These pin the SHAPE the host (Cuddler) codes against;
 * a platform added or renamed without updating the matrix fails here first.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const so = require('../../packages/social-ops');

const EXPECTED = ['x', 'instagram', 'discord', 'reddit', 'youtube', 'tiktok', 'xiaohongshu', 'wechat_channels', 'wechat_mp', 'bilibili', 'douyin', 'kuaishou'];

test('matrix covers exactly the twelve target platforms', () => {
  assert.deepEqual(so.capabilities.PLATFORM_IDS, EXPECTED);
});

test('every platform declares a valid publish mode, auth kind, limits and docs', () => {
  const modes = new Set(Object.values(so.capabilities.PUBLISH_MODES));
  for (const p of so.capabilities.listPlatforms()) {
    assert.ok(modes.has(p.publishMode), `${p.id} mode`);
    assert.ok(p.auth && typeof p.auth.kind === 'string', `${p.id} auth`);
    assert.ok(Number.isFinite(p.text.maxLength) && p.text.maxLength > 0, `${p.id} maxLength`);
    assert.ok(Number.isFinite(p.limits.perDay) && p.limits.perDay > 0, `${p.id} perDay`);
    assert.match(p.docs, /^https:\/\//, `${p.id} docs`);
    assert.equal(typeof p.endpointsVerified, 'boolean', `${p.id} endpointsVerified`);
    assert.ok(Array.isArray(p.credentialShape), `${p.id} credentialShape`);
  }
});

test('manual_package platforms are exactly 小红书 + 视频号, and need no credentials', () => {
  const manual = so.capabilities.platformsByMode('manual_package').map((p) => p.id);
  assert.deepEqual(manual, ['xiaohongshu', 'wechat_channels']);
  for (const id of manual) assert.deepEqual(so.capabilities.getPlatform(id).credentialShape, []);
  assert.equal(so.capabilities.hasWriteApi('xiaohongshu'), false);
  assert.equal(so.capabilities.hasWriteApi('x'), true);
});

test('公众号 is draft-first (api_draft)', () => {
  assert.equal(so.capabilities.getPlatform('wechat_mp').publishMode, 'api_draft');
});

test('CN open-platform connectors are flagged unverified + audit-gated so nobody issues keys blind', () => {
  for (const id of ['bilibili', 'douyin', 'kuaishou']) {
    const p = so.capabilities.getPlatform(id);
    assert.equal(p.endpointsVerified, false, id);
    assert.equal(p.requiresPlatformAudit, true, id);
    assert.ok(p.auditNote, `${id} auditNote`);
  }
  assert.equal(so.capabilities.getPlatform('tiktok').requiresPlatformAudit, true);
});

test('aliases resolve to canonical ids', () => {
  assert.equal(so.capabilities.resolvePlatformId('twitter'), 'x');
  assert.equal(so.capabilities.resolvePlatformId('XHS'), 'xiaohongshu');
  assert.equal(so.capabilities.resolvePlatformId('weixin'), 'wechat_mp');
  assert.equal(so.capabilities.resolvePlatformId('nope'), null);
});

test('every connector satisfies the contract and maps 1:1 to the matrix', () => {
  const ids = so.connectors.listConnectors().map((c) => (so.connectors.assertConnectorContract(c), c.platform));
  assert.deepEqual(ids, EXPECTED);
  assert.equal(so.connectors.getConnector('twitter').platform, 'x');
  assert.equal(so.connectors.getConnector('nope'), null);
});

test('assertConnectorContract rejects a connector missing a member', () => {
  assert.throws(() => so.connectors.assertConnectorContract({ platform: 'x', capabilities: {}, validate() {}, publish() {} }), /fetchMetrics/);
  assert.throws(() => so.connectors.assertConnectorContract({ platform: 'nope', capabilities: {}, validate() {}, publish() {}, fetchMetrics() {} }), /not in the capability matrix/);
});

test('manifest is serialisable, holds no credentials, and lists refusals with alternatives', () => {
  const m = JSON.parse(JSON.stringify(so.manifest()));
  assert.equal(m.holdsCredentials, false);
  assert.equal(m.platforms.length, 12);
  assert.ok(m.refusals.length >= 5);
  for (const r of m.refusals) {
    assert.ok(r.id && r.refused && r.why && r.instead, r.id);
  }
  const ids = m.refusals.map((r) => r.id);
  for (const must of ['bot_account_farms', 'mass_mailbox_registration', 'cold_dm_automation', 'headless_browser_login']) assert.ok(ids.includes(must), must);
  assert.deepEqual(m.capabilities.oauth, ['x', 'instagram', 'youtube', 'tiktok', 'reddit', 'douyin', 'kuaishou', 'bilibili']);
  assert.equal(typeof m.version, 'string');
});

test('createSocialOps binds deps and refuses unknown platforms as results, not throws', async () => {
  const ops = so.createSocialOps({ fetch: async () => { throw new Error('no network in tests'); } });
  const r = await ops.publish('nope', {}, { text: 'x' });
  assert.equal(r.success, false);
  assert.match(r.error, /unknown platform/);
  assert.deepEqual(ops.validate('nope', {}), ['unknown platform: nope']);
  const m = await ops.fetchMetrics('nope', {}, 'id');
  assert.equal(m.available, false);
});

test('package never reads process.env for credentials', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '../../packages/social-ops');
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      // Real reads only (`process.env.X` / `process.env[...]`); prose in a
      // docblock saying the package never does this is not a read.
      if (/process\.env(\.[A-Za-z_$]|\[)/.test(src)) offenders.push(path.relative(root, p));
    }
  })(root);
  assert.deepEqual(offenders, []);
});
