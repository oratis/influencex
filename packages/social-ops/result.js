'use strict';

/**
 * Result + HTTP helpers shared by every connector.
 *
 * Connectors never throw on a platform refusal — they return
 * `{ success: false, error, retryable }` so a host can decide between
 * retry / park / alert without parsing exception messages. Genuine
 * programming errors (missing deps, bad arguments to the library itself)
 * still throw.
 */

function ok(data = {}) {
  return { success: true, ...data };
}

function fail(error, extra = {}) {
  return { success: false, error, retryable: false, ...extra };
}

/**
 * Classify an HTTP status the way the retry policy needs it:
 *   - 429 and 5xx are transient (retry with backoff);
 *   - 401/403 mean the credential is dead (re-auth, never retry);
 *   - every other 4xx is a caller error (fix input, never retry).
 */
function classifyStatus(status) {
  if (status === 429) return { retryable: true, kind: 'rate_limit' };
  if (status >= 500) return { retryable: true, kind: 'server' };
  if (status === 401 || status === 403) return { retryable: false, kind: 'auth' };
  if (status >= 400) return { retryable: false, kind: 'client' };
  return { retryable: false, kind: 'ok' };
}

/** Read an error body defensively (text first, never assume JSON). */
async function readErrorText(res, limit = 300) {
  try {
    const t = await res.text();
    return String(t || '').slice(0, limit);
  } catch {
    return '';
  }
}

/** Build the standard failure for a non-2xx platform response. */
async function httpFailure(label, res) {
  const detail = await readErrorText(res);
  const cls = classifyStatus(res.status);
  return fail(`${label} ${res.status}${detail ? `: ${detail}` : ''}`, {
    status: res.status,
    retryable: cls.retryable,
    kind: cls.kind,
  });
}

/** JSON parse that never throws (platforms sometimes answer 200 with HTML). */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Resolve the dependency bag every connector receives. `fetch` is injected so a
 * host can route through a proxy (InfluenceX's proxy-fetch) or a test stub;
 * the default is the platform fetch. Nothing here reads process.env.
 */
function resolveDeps(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('social-ops: a fetch implementation is required (Node 20+ or deps.fetch)');
  }
  return {
    fetch: fetchImpl,
    now: deps.now || (() => new Date()),
    logger: deps.logger || { info() {}, warn() {}, error() {}, debug() {} },
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    // Some hosts wrap outbound calls (rate-limit, tracing). Optional.
    userAgent: deps.userAgent || 'influencex-social-ops/0.1',
  };
}

/** Fetch a public media URL into a Buffer with its content-type. */
async function fetchBinary(url, deps) {
  const res = await deps.fetch(url);
  if (!res.ok) {
    return { error: `Failed to fetch media url (${res.status})`, status: res.status };
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const contentLength = res.headers.get('content-length');
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType, contentLength: contentLength ? Number(contentLength) : buf.length };
}

module.exports = { ok, fail, classifyStatus, readErrorText, httpFailure, readJson, resolveDeps, fetchBinary };
