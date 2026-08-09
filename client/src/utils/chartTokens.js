/**
 * Chart colour tokens.
 *
 * recharts needs literal colour strings (it hands them to SVG attributes and
 * to inline legend swatch styles), so it can't consume `var(--x)` reliably.
 * Rather than scattering hex literals across .jsx (design.md §0 calls that a
 * bug), the values live in `client/src/index.css` `:root` as `--chart-*` and
 * are read back here once via getComputedStyle.
 *
 * If the computed value isn't available (SSR, jsdom without layout, a stylesheet
 * that hasn't parsed yet) we fall back to the `var(--chart-n)` string, which
 * browsers still resolve for SVG presentation attributes.
 */

const CHART_VARS = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4',
  '--chart-5', '--chart-6', '--chart-7', '--chart-8',
];

const cache = new Map();

/** Resolve a single CSS custom property to a literal colour string. */
export function token(name) {
  if (cache.has(name)) return cache.get(name);
  let value = '';
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch { /* jsdom / detached document */ }
  }
  const resolved = value || `var(${name})`;
  cache.set(name, resolved);
  return resolved;
}

/** Ordered categorical palette (design.md §12). */
export function chartPalette() {
  return CHART_VARS.map(token);
}

/** Named accessors for the semantic series colours. */
export const chartColors = {
  get accent() { return token('--accent'); },
  get info() { return token('--info'); },
  get success() { return token('--success'); },
  get warning() { return token('--warning'); },
  get danger() { return token('--danger'); },
  get violet() { return token('--chart-4'); },
  get teal() { return token('--chart-8'); },
};

// Test seam: index.css isn't loaded in unit tests, so let a test reset the
// memoised values if it stubs getComputedStyle.
export function __resetChartTokenCache() { cache.clear(); }
