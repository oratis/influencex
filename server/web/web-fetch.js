/**
 * Web fetch helper with SSRF guards — the single entry point for every
 * fetch of a user- or LLM-supplied URL (agent page scrapes, the
 * fetch-as-data-url proxy, TikTok/Instagram HTML fallbacks).
 *
 * - HTTPS only
 * - Blocks private IPs / localhost / metadata endpoints, including the
 *   decimal / hex / octal IPv4 spellings and IPv6 loopback + ULA + link-local
 * - Redirects are followed MANUALLY so every hop is re-validated. Letting
 *   the platform fetch follow them would let `https://evil.example/` 302 to
 *   `http://169.254.169.254/latest/meta-data/` and sail past the check that
 *   only ever saw the first URL.
 * - 30s timeout
 * - 10MB response cap
 * - Returns { status, html, textSnippet, title, links } — textSnippet is the
 *   visible body text with HTML stripped + whitespace normalized (first 15KB)
 */

const fetch = require('../proxy-fetch');
const { URL } = require('url');

const PRIVATE_HOST_RE = /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Max redirect hops before we give up. Matches the browser/undici default.
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Normalize the non-dotted-quad IPv4 spellings the URL parser happily
 * accepts — `http://2130706433/`, `http://0x7f.1/`, `http://017700000001/`
 * all reach 127.0.0.1 but none of them match a dotted-quad regex. Returns a
 * dotted-quad string, or null when the host isn't an IPv4 literal at all.
 */
function normalizeIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length > 4 || parts.length === 0) return null;
  const nums = [];
  for (const part of parts) {
    if (part === '') return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return null; // contains letters — a real hostname, not an IP literal
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Trailing part absorbs the remaining octets (a.b.c.d / a.b.c / a.b / a).
  const last = nums.pop();
  const maxLast = Math.pow(256, 4 - nums.length);
  if (last >= maxLast) return null;
  if (nums.some(n => n > 255)) return null;
  let value = last;
  for (let i = nums.length - 1; i >= 0; i--) {
    value += nums[i] * Math.pow(256, 4 - 1 - i);
  }
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

function isBlockedIpv6(hostname) {
  // URL parser keeps IPv6 literals in brackets.
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (addr === '::1' || addr === '::' || addr === '::0') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  // IPv4-mapped. Written as `::ffff:127.0.0.1`, but the WHATWG URL parser
  // normalizes that to the hex form `::ffff:7f00:1` — handle both.
  const mappedDotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return PRIVATE_HOST_RE.test(mappedDotted[1]);
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [hi >> 8, hi & 0xFF, lo >> 8, lo & 0xFF].join('.');
    return PRIVATE_HOST_RE.test(dotted);
  }
  return false;
}

/**
 * True when the hostname resolves to (or literally is) something we refuse
 * to talk to. Note this is a *literal* check — it does not resolve DNS, so a
 * hostile DNS record pointing at 169.254.169.254 still gets through. That
 * gap is accepted for now; closing it needs a resolve-then-pin dispatcher.
 */
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (isBlockedIpv6(host)) return true;
  if (PRIVATE_HOST_RE.test(host)) return true;
  const v4 = normalizeIpv4(host);
  if (v4 && PRIVATE_HOST_RE.test(v4)) return true;
  return false;
}

function assertSafeUrl(urlString) {
  if (!/^https:\/\//i.test(urlString)) throw new Error('Only HTTPS URLs allowed');
  const u = new URL(urlString);
  if (isBlockedHost(u.hostname)) {
    throw new Error(`URL points to a blocked host range: ${u.hostname}`);
  }
  return u;
}

function stripHtml(html) {
  if (!html) return '';
  // Remove script/style blocks entirely (including content)
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                 .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                 .replace(/<!--[\s\S]*?-->/g, ' ');
  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|aside|main)>/gi, '\n')
             .replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  return text.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : null;
}

function extractLinks(html, baseUrl, limit = 50) {
  const links = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let count = 0;
  while ((m = re.exec(html)) !== null && count < limit) {
    try {
      const href = new URL(m[1], baseUrl).href;
      if (!/^https?:/.test(href)) continue;
      const text = stripHtml(m[2]).slice(0, 120);
      links.push({ href, text });
      count++;
    } catch { /* skip bad URLs */ }
  }
  return links;
}

const DEFAULT_UA = 'InfluenceX-Agent/1.0 (+https://influencexes.com)';

/**
 * Low-level guarded fetch. Returns the raw Response plus the URL we actually
 * ended up on, having validated every redirect hop. Callers that need bytes
 * rather than parsed HTML (image proxying, JSON APIs) use this directly.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {Object} [opts.headers]
 * @param {number} [opts.timeoutMs=30000]
 * @param {number} [opts.maxRedirects=5]
 * @param {AbortSignal} [opts.signal] — caller-owned abort, honoured alongside the timeout
 * @param {Function} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<{ response: Response, finalUrl: string, redirects: string[] }>}
 */
async function safeFetchRaw(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const doFetch = opts.fetchImpl || fetch;

  let current = String(url);
  assertSafeUrl(current);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

  const redirects = [];
  try {
    for (let hop = 0; ; hop++) {
      const response = await doFetch(current, {
        method: opts.method || 'GET',
        signal: controller.signal,
        // The whole point: never let the HTTP client follow a redirect for
        // us, because that hop would skip assertSafeUrl.
        redirect: 'manual',
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(opts.headers || {}),
        },
      });

      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get('location')
        : null;
      if (!location) return { response, finalUrl: current, redirects };

      if (hop >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
      let next;
      try { next = new URL(location, current).href; }
      catch { throw new Error('Redirect to a malformed URL'); }
      // Re-validate the hop. A 302 to http://169.254.169.254/ dies here.
      assertSafeUrl(next);
      redirects.push(next);
      current = next;
    }
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch a URL safely and return structured payload.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {number} [opts.maxBytes=10485760]  — cap on response size
 * @param {number} [opts.timeoutMs=30000]
 * @param {boolean} [opts.extractLinks=true]
 */
async function safeFetch(url, opts = {}) {
  const maxBytes = opts.maxBytes || 10 * 1024 * 1024;

  const { response: r, finalUrl } = await safeFetchRaw(url, opts);
  const contentType = r.headers.get('content-type') || 'text/html';
  const contentLength = parseInt(r.headers.get('content-length') || '0');
  if (contentLength > maxBytes) throw new Error(`Content too large (${contentLength} > ${maxBytes})`);

  const body = await r.text();
  if (body.length > maxBytes) throw new Error(`Content too large (${body.length} > ${maxBytes})`);

  const isHtml = /html|xml/.test(contentType);
  const textSnippet = isHtml ? stripHtml(body).slice(0, 15000) : body.slice(0, 15000);
  const title = isHtml ? extractTitle(body) : null;
  // Relative hrefs resolve against the URL we actually landed on, not the
  // one we asked for.
  const links = isHtml && opts.extractLinks !== false ? extractLinks(body, finalUrl) : [];

  return {
    ok: r.ok,
    status: r.status,
    url: finalUrl,
    requested_url: url,
    content_type: contentType,
    html: body.slice(0, maxBytes),
    text: textSnippet,
    title,
    links,
    byte_size: body.length,
  };
}

module.exports = {
  safeFetch, safeFetchRaw, stripHtml, extractTitle, extractLinks,
  assertSafeUrl, isBlockedHost, normalizeIpv4,
};
