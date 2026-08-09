/**
 * YouTube Data API v3 request-URL builder.
 *
 * Why this exists: the call sites used to interpolate values straight into a
 * template literal —
 *
 *     `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${KEY}`
 *
 * — and several of those values are derived from a user-submitted profile URL
 * (the `@handle`, the `/c/<name>` custom name, the `/channel/<id>` segment).
 * A handle containing `&` or `#` therefore injected or truncated query
 * parameters in an authenticated, quota-metered third-party call:
 *
 *     @abc&part=contentDetails  → ...?part=id&forHandle=abc&part=contentDetails&key=...
 *     @abc&key=                 → shadows our API key parameter
 *     @abc#                     → truncates everything after it, key included
 *
 * The host is fixed, so this is not SSRF — but it produces wrong results and
 * confusing quota charges, so every value now goes through encodeURIComponent
 * here rather than being trusted at ~13 scattered call sites.
 *
 * Usage:
 *     youtubeApiUrl('channels', { part: ['snippet', 'statistics'], id, key })
 *
 * Array values are joined on a literal comma — that is the Data API's list
 * separator for `part` / `id`. Each element is encoded individually, so the
 * separator stays structural and an element can never smuggle one in. We do
 * not hand list params to URLSearchParams because it would emit the separator
 * as `%2C`; per-element encoding + literal comma is the shape already proven
 * in production by the batch-discovery path.
 *
 * Null / undefined / empty values are dropped rather than serialised as the
 * string "undefined" (which is what the old templates did for a missing key).
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

function isEmpty(v) {
  return v === undefined || v === null || v === '';
}

/**
 * @param {string} endpoint  Data API resource, e.g. 'channels' | 'search' | 'videos' | 'playlistItems'
 * @param {Object} params    Query parameters. Values may be scalars or arrays (arrays → comma list).
 * @returns {string} Fully-encoded request URL.
 */
function youtubeApiUrl(endpoint, params = {}) {
  const parts = [];

  for (const [key, value] of Object.entries(params)) {
    if (isEmpty(value)) continue;

    let encoded;
    if (Array.isArray(value)) {
      const items = value.filter(v => !isEmpty(v));
      if (items.length === 0) continue;
      encoded = items.map(v => encodeURIComponent(v)).join(',');
    } else {
      encoded = encodeURIComponent(value);
    }

    parts.push(`${encodeURIComponent(key)}=${encoded}`);
  }

  const query = parts.join('&');
  return `${YOUTUBE_API_BASE}/${encodeURIComponent(endpoint)}${query ? `?${query}` : ''}`;
}

module.exports = { youtubeApiUrl, YOUTUBE_API_BASE };
