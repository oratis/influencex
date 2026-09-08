const { test } = require('node:test');
const assert = require('node:assert/strict');
const { community, matrix } = require('../../packages/social-ops');

test('ledger: contribute-first 7:1 with cooldown; snapshot round-trips', () => {
  const l = community.createContributionLedger();
  assert.equal(community.canPromote(l, 'r/writing').allowed, false);
  for (let i = 0; i < 7; i++) l.record('r/writing', 'contribution', '2026-09-01T00:00:00Z');
  const ok = community.canPromote(l, 'r/writing', { now: new Date('2026-09-08') });
  assert.equal(ok.allowed, true);
  l.record('r/writing', 'promotion', '2026-09-08T00:00:00Z');
  const ratio = community.canPromote(l, 'r/writing', { now: new Date('2026-09-20') });
  assert.equal(ratio.allowed, false);
  assert.match(ratio.reason, /ratio would drop to 3\.5:1/);
  for (let i = 0; i < 7; i++) l.record('r/writing', 'contribution');
  const cool = community.canPromote(l, 'r/writing', { now: new Date('2026-09-10') });
  assert.equal(cool.allowed, false);
  assert.match(cool.reason, /cooldown/);
  assert.equal(cool.nextAllowedAt, '2026-09-15T00:00:00.000Z');
  const l2 = community.createContributionLedger(l.snapshot());
  assert.deepEqual(l2.get('r/writing'), l.get('r/writing'));
  assert.throws(() => l.record('x', 'spam'), /unknown ledger kind/);
});

test('rules assessment + disclosure', () => {
  const a = community.assessCommunityRules([{ shortName: 'Be nice' }, { shortName: 'No self-promotion', description: '' }]);
  assert.equal(a.selfPromotionRestricted, true);
  assert.equal(a.matchedRules[0].shortName, 'No self-promotion');
  assert.equal(community.assessCommunityRules([{ shortName: 'Be nice' }]).selfPromotionRestricted, false);
  const l = community.createContributionLedger();
  for (let i = 0; i < 10; i++) l.record('sub', 'contribution');
  const blocked = community.canPromote(l, 'sub', { rulesAssessment: a });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /restrict self-promotion/);
  const en = community.buildDisclosedPost('Our new feature.', { brand: 'Cuddler', role: 'an engineer' });
  assert.match(en, /Disclosure: I am an engineer at Cuddler/);
  assert.equal(community.buildDisclosedPost(en, { brand: 'Cuddler' }), en, 'idempotent');
  const zh = community.buildDisclosedPost('新功能', { brand: 'Cuddler', locale: 'zh' });
  assert.match(zh, /利益相关/);
  assert.throws(() => community.buildDisclosedPost('x', {}), /brand/);
});

test('promoteOnReddit refuses before posting when the ledger says no, and never calls submit', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ rules: [] }), text: async () => '' };
  };
  const l = community.createContributionLedger();
  const r = await community.promoteOnReddit({ accessToken: 'T' }, { subreddit: 'test', title: 't', text: 'x', ledger: l, brand: 'Cuddler' }, { fetch });
  assert.equal(r.success, false);
  assert.equal(r.kind, 'policy');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /about\/rules/);
  assert.deepEqual(community.UNSUPPORTED.slice(0, 2), ['dm.cold_outbound', 'accounts.bulk_create']);
});

test('promoteOnReddit posts with disclosure once allowed and records the promotion', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (/about\/rules/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ rules: [] }), text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ json: { errors: [], data: { id: 'p1', name: 't3_p1', url: 'https://r/p1' } } }), text: async () => '' };
  };
  const l = community.createContributionLedger();
  for (let i = 0; i < 7; i++) l.record('test', 'contribution');
  const r = await community.promoteOnReddit({ accessToken: 'T' }, { subreddit: 'test', title: 't', text: 'x', ledger: l, brand: 'Cuddler' }, { fetch, now: () => new Date('2026-09-08') });
  assert.equal(r.success, true);
  assert.match(decodeURIComponent(String(calls[1].options.body)), /Disclosure/);
  assert.equal(l.get('test').promotions, 1);
});

test('matrix: owned/disclosed accounts pass; bot-farm shapes are refused by construction', () => {
  const ok = matrix.validateAccountProfile({ platform: 'x', kind: 'brand_regional', handle: '@cuddler_jp', holder: { name: 'A. Person' }, disclosure: 'Official Cuddler Japan account', authorization: 'oauth_consent' });
  assert.deepEqual(ok.errors, []);
  const bot = matrix.validateAccountProfile({ platform: 'x', kind: 'bot', handle: '@x1', holder: { name: 'gen' }, disclosure: 'none really', authorization: 'oauth_consent', proxyPool: 'us-residential' });
  assert.equal(bot.ok, false);
  assert.ok(bot.errors.some((e) => /refused: account kind "bot"/.test(e)));
  assert.ok(bot.errors.some((e) => /refused: proxyPool/.test(e)));
  const partner = matrix.validateAccountProfile({ platform: 'youtube', kind: 'creator_partner', handle: 'c', holder: { name: 'C' }, disclosure: 'Paid partnership with Cuddler', authorization: 'oauth_consent' });
  assert.ok(partner.errors.some((e) => /agreementRef/.test(e)));
  const bad = matrix.validateAccountProfile({ platform: 'myspace', kind: 'brand_main', authorization: 'password' });
  assert.ok(bad.errors.some((e) => /unknown platform/.test(e)));
  assert.ok(bad.errors.some((e) => /authorization must be one of/.test(e)));
});

test('matrix: stagger spreads posts round-robin with gaps and per-account daily caps', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }));
  const accounts = [{ id: 'a', platform: 'reddit' }, { id: 'b', platform: 'reddit' }];
  const { assignments, unscheduled } = matrix.planStagger(items, accounts, { startAt: '2026-09-08T00:00:00Z', minGapMinutes: 60, perAccountDailyCap: 2 });
  assert.equal(assignments.length, 4);
  assert.equal(unscheduled.length, 1);
  assert.deepEqual(assignments.map((a) => a.accountId), ['a', 'b', 'a', 'b']);
  assert.equal(assignments[0].scheduledAt, '2026-09-08T00:00:00.000Z');
  assert.equal(assignments[2].scheduledAt, '2026-09-08T01:00:00.000Z');
  assert.equal(matrix.dailyCapFor('x'), 50);
  assert.equal(matrix.dailyCapFor('x', 5), 5);
});
