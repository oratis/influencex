/**
 * Web fetch helper with SSRF guards — used by agents that need to scrape
 * public pages (reviews on Trustpilot, competitor landing pages, etc).
 *
 * - HTTPS only
 * - Blocks private IPs / localhost / metadata endpoints
 * - 30s timeout
 * - 10MB response cap
 * - Returns { status, html, textSnippet, title, links } — textSnippet is the
 *   visible body text with HTML stripped + whitespace normalized (first 15KB)
 */

const fetch = require('../proxy-fetch');
const { URL } = require('url');

const PRIVATE_HOST_RE = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

function assertSafeUrl(urlString) {
  if (!/^https:\/\//i.test(urlString)) throw new Error('Only HTTPS URLs allowed');
  const u = new URL(urlString);
  if (PRIVATE_HOST_RE.test(u.hostname) || u.hostname === 'localhost' || u.hostname.endsWith('.internal')) {
    throw new Error(`URL points to a blocked host range: ${u.hostname}`);
  }
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
  const timeoutMs = opts.timeoutMs || 30000;

  assertSafeUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'InfluenceX-Agent/1.0 (+https://influencexes.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = r.headers.get('content-type') || 'text/html';
    const contentLength = parseInt(r.headers.get('content-length') || '0');
    if (contentLength > maxBytes) throw new Error(`Content too large (${contentLength} > ${maxBytes})`);

    const body = await r.text();
    if (body.length > maxBytes) throw new Error(`Content too large (${body.length} > ${maxBytes})`);

    const isHtml = /html|xml/.test(contentType);
    const textSnippet = isHtml ? stripHtml(body).slice(0, 15000) : body.slice(0, 15000);
    const title = isHtml ? extractTitle(body) : null;
    const links = isHtml && opts.extractLinks !== false ? extractLinks(body, url) : [];

    return {
      ok: r.ok,
      status: r.status,
      url,
      content_type: contentType,
      html: body.slice(0, maxBytes),
      text: textSnippet,
      title,
      links,
      byte_size: body.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { safeFetch, stripHtml, extractTitle, extractLinks, assertSafeUrl };
