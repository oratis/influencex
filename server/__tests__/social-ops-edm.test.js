const { test } = require('node:test');
const assert = require('node:assert/strict');
const { edm } = require('../../packages/social-ops');

const GOOD = {
  from: { address: 'news@market.hakko.ai', name: 'Cuddler' },
  subject: 'This week on Cuddler',
  html: '<p>hi</p><p><a href="https://cuddler.ai/u/abc">Unsubscribe</a></p><p>1 Example St, City</p>',
  text: 'hi\nUnsubscribe: https://cuddler.ai/u/abc\n1 Example St, City',
  unsubscribeUrl: 'https://cuddler.ai/u/abc',
  physicalAddress: '1 Example St, City',
  listUnsubscribe: { url: 'https://cuddler.ai/u/abc', mailto: 'unsub@market.hakko.ai' },
  oneClickUnsubscribe: true,
  auth: { spf: true, dkim: true, dmarc: 'quarantine' },
};

test('compliance: a well-formed bulk campaign passes with no errors', () => {
  const r = edm.checkCampaignCompliance(GOOD);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.fromDomain, 'market.hakko.ai');
});

test('compliance: consumer mailbox sender, missing unsubscribe/address, fake Re:, no one-click all fail', () => {
  const r = edm.checkCampaignCompliance({ ...GOOD, from: { address: 'brand123@gmail.com' }, subject: 'Re: your account', html: '<p>hi</p>', text: '', listUnsubscribe: {}, oneClickUnsubscribe: false, auth: { spf: false, dkim: null, dmarc: null } });
  const msgs = r.errors.join('\n');
  assert.equal(r.ok, false);
  assert.match(msgs, /consumer mailbox domain \(gmail\.com\)/);
  assert.match(msgs, /unsubscribeUrl does not appear/);
  assert.match(msgs, /physicalAddress does not appear/);
  assert.match(msgs, /imitates a reply/);
  assert.match(msgs, /List-Unsubscribe header/);
  assert.match(msgs, /one-click unsubscribe/);
  assert.match(msgs, /SPF is not passing/);
  assert.ok(r.warnings.some((w) => /DMARC policy unknown/.test(w)));
});

test('compliance: unsubscribeHeaders emits RFC 2369 + RFC 8058', () => {
  const h = edm.unsubscribeHeaders({ url: 'https://u', mailto: 'x@y.z' });
  assert.equal(h['List-Unsubscribe'], '<mailto:x@y.z>, <https://u>');
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.throws(() => edm.unsubscribeHeaders({}), /url or mailto/);
});

test('suppression: events map to reasons, soft bounces do not suppress, rank never downgrades', () => {
  const list = edm.suppressionFromEvents([
    { type: 'email.bounced', email: 'a@x.io', bounceType: 'Permanent' },
    { type: 'email.bounced', email: 'b@x.io', bounceType: 'Transient' },
    { type: 'complained', email: 'c@x.io' },
    { type: 'unsubscribed', email: 'D@X.IO' },
  ]);
  assert.equal(list.has('a@x.io'), true);
  assert.equal(list.has('b@x.io'), false);
  assert.equal(list.reason('c@x.io'), 'complained');
  assert.equal(list.has('d@x.io'), true);
  list.add('c@x.io', 'blocked');
  assert.equal(list.reason('c@x.io'), 'complained');
  assert.throws(() => list.add('e@x.io', 'whatever'), /unknown suppression reason/);
  assert.equal(list.size, 3);
});

test('audience: only consented recipients pass; purchased/scraped lists cannot be expressed', () => {
  const sup = edm.createSuppressionList(['sup@x.io']);
  const r = edm.filterAudience([
    { email: 'ok@x.io', consent: 'explicit', region: 'DE' },
    { email: 'ok@x.io', consent: 'explicit' }, // duplicate
    { email: 'soft-us@x.io', consent: 'soft_opt_in', existingCustomer: true, region: 'US' },
    { email: 'soft-de@x.io', consent: 'soft_opt_in', existingCustomer: true, region: 'DE' },
    { email: 'soft-nocust@x.io', consent: 'soft_opt_in', region: 'US' },
    { email: 'none@x.io' },
    { email: 'bought@x.io', consent: 'explicit', source: 'purchased' },
    { email: 'sup@x.io', consent: 'explicit' },
    { email: 'unsub@x.io', consent: 'explicit', unsubscribedAt: '2026-01-01' },
    { email: 'not-an-email', consent: 'explicit' },
    { email: 'old@x.io', consent: 'explicit', consentAt: '2020-01-01' },
  ], { suppression: sup, maxConsentAgeDays: 730, now: new Date('2026-09-08') });
  assert.deepEqual(r.eligible.map((e) => e.email), ['ok@x.io', 'soft-us@x.io']);
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.email, e.reason]));
  assert.equal(reasons['soft-de@x.io'], 'explicit_consent_required:DE');
  assert.equal(reasons['soft-nocust@x.io'], 'soft_opt_in_requires_existing_customer');
  assert.equal(reasons['none@x.io'], 'no_consent');
  assert.equal(reasons['bought@x.io'], 'no_consent_basis:purchased');
  assert.equal(reasons['sup@x.io'], 'suppressed:blocked');
  assert.equal(reasons['unsub@x.io'], 'unsubscribed');
  assert.equal(reasons['not-an-email'], 'invalid_email');
  assert.equal(reasons['old@x.io'], 'consent_stale');
  assert.equal(r.stats.eligible, 2);
});

test('batch: warm-up caps, day index, breaker trips on complaint rate after min sample', () => {
  assert.equal(edm.warmupCap(0), 50);
  assert.equal(edm.warmupCap(3), 500);
  assert.equal(edm.warmupCap(99), Infinity);
  assert.equal(edm.warmupDayIndex('2026-09-01T00:00:00Z', new Date('2026-09-04T12:00:00Z')), 3);
  const b = edm.createComplaintBreaker({ minSample: 100 });
  b.record({ sent: 50, complaints: 5 });
  assert.equal(b.isOpen(), false, 'below sample');
  b.record({ sent: 50 });
  assert.equal(b.isOpen(), true);
  assert.match(b.reason(), /complaint rate 5\.00%/);
  b.reset();
  assert.equal(b.isOpen(), false);
  assert.deepEqual(edm.splitBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(edm.intervalMs(5), 200);
});

test('campaign: rate-limited, suppression-aware, breaker/cap/budget stop with a resumable cursor', async () => {
  const sent = [];
  const sleeps = [];
  const recipients = Array.from({ length: 6 }, (_, i) => ({ email: `r${i}@x.io` }));
  const sup = edm.createSuppressionList(['r1@x.io']);
  const r = await edm.runEdmCampaign({
    recipients,
    render: (rcp) => ({ subject: `hi ${rcp.email}`, text: 'body', unsubscribeUrl: 'https://u' }),
    send: async (m) => { sent.push(m); return m.to === 'r3@x.io' ? { ok: false, error: 'hard bounce', retryable: false } : { ok: true, messageId: 'id' }; },
    suppression: sup,
    ratePerSec: 10,
    listUnsubscribe: { url: 'https://u' },
    dailyCap: 4,
    breaker: edm.createComplaintBreaker({ minSample: 1000 }),
  }, { sleep: async (ms) => { sleeps.push(ms); }, now: () => new Date() });
  assert.equal(r.sent, 4); // r0, r2, r4, r5 (r1 suppressed, r3 failed) — the cap counts successful sends only
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.failures[0].email, 'r3@x.io');
  assert.equal(sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(sleeps.every((ms) => ms === 100));
  assert.equal(r.done, true);
  assert.equal(r.cursor, 6);

  // Daily cap stops early with a cursor the next run resumes from.
  const capped = await edm.runEdmCampaign({ recipients, render: () => ({ subject: 's', text: 't' }), send: async () => ({ ok: true }), dailyCap: 2 }, { sleep: async () => {} });
  assert.equal(capped.sent, 2);
  assert.equal(capped.stoppedReason, 'daily_cap');
  assert.equal(capped.cursor, 2);
  assert.equal(capped.done, false);

  // Open breaker refuses to send at all.
  const br = edm.createComplaintBreaker({ minSample: 1 });
  br.record({ sent: 10, complaints: 5 });
  const stopped = await edm.runEdmCampaign({ recipients, render: () => ({ subject: 's', text: 't' }), send: async () => ({ ok: true }), breaker: br }, { sleep: async () => {} });
  assert.equal(stopped.sent, 0);
  assert.match(stopped.stoppedReason, /^breaker_open/);

  // Budget exhaustion.
  let t = 0;
  const budget = await edm.runEdmCampaign({ recipients, render: () => ({ subject: 's', text: 't' }), send: async () => ({ ok: true }), budgetMs: 150 }, { sleep: async () => { t += 100; }, now: () => new Date(t) });
  assert.equal(budget.stoppedReason, 'budget_exhausted');
  assert.ok(budget.sent >= 1 && budget.sent < 6);
});
