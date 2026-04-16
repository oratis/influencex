/**
 * Proxy-aware fetch wrapper
 * Uses system proxy (HTTP_PROXY/HTTPS_PROXY) if configured
 * Falls back to global fetch if no proxy
 */

const { ProxyAgent, fetch: undiciFetch } = require('undici');

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

let proxyAgent = null;
if (PROXY_URL) {
  try {
    proxyAgent = new ProxyAgent(PROXY_URL);
    console.log(`[proxy-fetch] Using proxy: ${PROXY_URL}`);
  } catch (e) {
    console.warn(`[proxy-fetch] Failed to create proxy agent: ${e.message}`);
  }
}

async function proxyFetch(url, options = {}) {
  if (proxyAgent) {
    return undiciFetch(url, { ...options, dispatcher: proxyAgent });
  }
  return fetch(url, options);
}

module.exports = proxyFetch;
