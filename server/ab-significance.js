/**
 * A/B test significance helpers.
 *
 * We use a two-proportion z-test for the null hypothesis that two binomial
 * rates (e.g. reply_rate of variant A vs. B) are equal. Returns a two-tailed
 * p-value, or null for degenerate inputs (zero sample, identical proportions
 * with zero standard error).
 *
 * The normal CDF is approximated via Abramowitz-Stegun 26.2.17 — accurate
 * to ~1e-7 in the tails, which is far more precision than our A/B calls need
 * and avoids a dependency.
 */

function twoPropZPValue(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = Math.abs((p1 - p2) / se);
  return 2 * (1 - normalCdf(z));
}

function normalCdf(z) {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const t = 1 / (1 + p * z);
  const pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  return 1 - pdf * (b1 * t + b2 * t * t + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));
}

module.exports = { twoPropZPValue, normalCdf };
