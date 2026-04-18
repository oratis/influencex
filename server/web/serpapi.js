/**
 * SerpAPI adapter — real Google SERP data for SEO + competitor research.
 *
 * Requires SERPAPI_API_KEY. When unset, all methods return
 *   { configured: false }
 * so callers can degrade gracefully to LLM-only mode.
 */

const fetch = require('../proxy-fetch');

const BASE = 'https://serpapi.com/search.json';

function isConfigured() {
  return !!process.env.SERPAPI_API_KEY;
}

/**
 * Google search for a query. Returns top organic results.
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} [opts.limit=10]
 * @param {string} [opts.gl='us']   — country
 * @param {string} [opts.hl='en']   — language
 */
async function search({ query, limit = 10, gl = 'us', hl = 'en' }) {
  if (!isConfigured()) return { configured: false };
  const url = `${BASE}?${new URLSearchParams({
    engine: 'google',
    q: query,
    num: String(Math.min(limit, 20)),
    gl, hl,
    api_key: process.env.SERPAPI_API_KEY,
  }).toString()}`;

  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`SerpAPI ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();

  const organic = (data.organic_results || []).slice(0, limit).map(r => ({
    position: r.position,
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    displayed_link: r.displayed_link,
    site_name: r.source || r.displayed_link,
  }));

  return {
    configured: true,
    query,
    organic,
    related_questions: (data.related_questions || []).map(q => q.question).slice(0, 5),
    related_searches: (data.related_searches || []).map(s => s.query).slice(0, 8),
    total_results: data.search_information?.total_results || null,
  };
}

/**
 * Keyword ideas + volume via SerpAPI's Google Autocomplete engine.
 * This is a crude substitute for Ahrefs/SEMrush; good enough for v1.
 */
async function keywordIdeas({ seed, gl = 'us', hl = 'en' }) {
  if (!isConfigured()) return { configured: false };
  const url = `${BASE}?${new URLSearchParams({
    engine: 'google_autocomplete',
    q: seed,
    gl, hl,
    api_key: process.env.SERPAPI_API_KEY,
  }).toString()}`;

  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`SerpAPI autocomplete ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return {
    configured: true,
    seed,
    suggestions: (data.suggestions || []).map(s => s.value).slice(0, 20),
  };
}

module.exports = {
  isConfigured,
  search,
  keywordIdeas,
};
