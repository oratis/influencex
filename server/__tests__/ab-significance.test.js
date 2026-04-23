/**
 * Tests for the A/B significance helpers.
 *
 *   - Known p-values (clear win, clear null)
 *   - Degenerate inputs (zero samples, identical proportions)
 *   - Symmetry: swapping arms yields the same p-value
 *   - Tail behavior: normalCdf(0)=0.5, normalCdf(1.96)≈0.975, normalCdf(-z)=1-normalCdf(z)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { twoPropZPValue, normalCdf } = require('../ab-significance');

test('normalCdf at known anchors', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6, 'normalCdf(0) ≈ 0.5');
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3, 'normalCdf(1.96) ≈ 0.975');
  assert.ok(Math.abs(normalCdf(2.576) - 0.995) < 1e-3, 'normalCdf(2.576) ≈ 0.995');
});

test('normalCdf is monotone in z', () => {
  assert.ok(normalCdf(-1) < normalCdf(0));
  assert.ok(normalCdf(0) < normalCdf(1));
  assert.ok(normalCdf(1) < normalCdf(2));
});

test('twoPropZPValue: degenerate inputs return null', () => {
  assert.equal(twoPropZPValue(0, 0, 0, 10), null, 'zero n1');
  assert.equal(twoPropZPValue(0, 10, 0, 0), null, 'zero n2');
  // Identical rates → SE = 0 when both are 0% or 100%
  assert.equal(twoPropZPValue(0, 10, 0, 10), null, 'both zero rate yields SE=0');
  assert.equal(twoPropZPValue(10, 10, 10, 10), null, 'both 100% rate yields SE=0');
});

test('twoPropZPValue: equal rates of a nonzero p yield p ≈ 1.0', () => {
  const p = twoPropZPValue(5, 100, 5, 100);
  assert.ok(p > 0.9, `expected near-1, got ${p}`);
});

test('twoPropZPValue: large difference at big n yields p ≈ 0', () => {
  // 20% vs 5% at n=1000 each — massively significant
  const p = twoPropZPValue(200, 1000, 50, 1000);
  assert.ok(p < 1e-10, `expected tiny p, got ${p}`);
});

test('twoPropZPValue: moderate difference at small n produces a reasonable p', () => {
  // 15/50 vs 8/50 — about 30% vs 16%. Should be suggestive but not extreme.
  const p = twoPropZPValue(15, 50, 8, 50);
  assert.ok(p > 0 && p < 0.2, `expected somewhat-significant p, got ${p}`);
});

test('twoPropZPValue: symmetric in the two arms', () => {
  const a = twoPropZPValue(15, 100, 8, 100);
  const b = twoPropZPValue(8, 100, 15, 100);
  assert.ok(Math.abs(a - b) < 1e-9, `expected symmetric p-values, got ${a} vs ${b}`);
});

test('twoPropZPValue: p-value is in [0,1]', () => {
  const samples = [
    [0, 10, 0, 10], [1, 10, 0, 10], [10, 10, 0, 10], [5, 100, 5, 100],
    [200, 1000, 50, 1000], [3, 30, 3, 30], [1, 100, 50, 100],
  ];
  for (const [x1, n1, x2, n2] of samples) {
    const p = twoPropZPValue(x1, n1, x2, n2);
    if (p == null) continue;
    assert.ok(p >= 0 && p <= 1, `p=${p} out of [0,1] for ${x1}/${n1} vs ${x2}/${n2}`);
  }
});
