/**
 * SSRF guard tests for server/web/web-fetch.js.
 *
 * The bug this pins down: assertSafeUrl only ever saw the URL the caller
 * passed. With the platform fetch following redirects for us, an attacker
 * supplied `https://their-host.example/img.png`, it 302'd to
 * `http://169.254.169.254/computeMetadata/v1/`, and the response came back
 * through /api/util/fetch-as-data-url as a data: URL — the cloud metadata
 * service, base64'd, in an API response.
 *
 * safeFetchRaw now follows redirects itself and re-runs the host check on
 * every hop. Fetch is injected so nothing here touches the network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeFetchRaw, assertSafeUrl, isBlockedHost, normalizeIpv4 } = require('../web/web-fetch');

// Minimal Response stand-in: only .status and .headers.get are used by the
// redirect loop.
function res(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    async text() { return 'body'; },
  };
}

/** Scripted fetch: a map of url -> Response, plus a log of what was requested. */
function scriptedFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return typeof r === 'function' ? r() : r;
  };
  impl.seen = seen;
  return impl;
}

// ==================== Host classification ====================

test('assertSafeUrl rejects non-HTTPS schemes', () => {
  assert.throws(() => assertSafeUrl('http://example.com/'), /Only HTTPS/);
  assert.throws(() => assertSafeUrl('file:///etc/passwd'), /Only HTTPS/);
  assert.throws(() => assertSafeUrl('gopher://example.com/'), /Only HTTPS/);
});

test('assertSafeUrl rejects loopback, private ranges and cloud metadata', () => {
  for (const host of [
    'localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', 'metadata.google.internal', '0.0.0.0',
  ]) {
    assert.throws(() => assertSafeUrl(`https://${host}/x`), /blocked host range/, `${host} should be blocked`);
  }
});

test('assertSafeUrl rejects the non-dotted-quad spellings of 127.0.0.1', () => {
  // All of these resolve to loopback but match no dotted-quad regex.
  for (const host of ['2130706433', '0x7f.0.0.1', '017700000001', '127.1']) {
    assert.throws(() => assertSafeUrl(`https://${host}/x`), /blocked host range/, `${host} should be blocked`);
  }
  assert.equal(normalizeIpv4('2130706433'), '127.0.0.1');
});

test('assertSafeUrl rejects IPv6 loopback, ULA, link-local and v4-mapped loopback', () => {
  for (const host of ['[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
    assert.throws(() => assertSafeUrl(`https://${host}/x`), /blocked host range/, `${host} should be blocked`);
  }
});

test('assertSafeUrl allows ordinary public hosts', () => {
  for (const host of ['example.com', 'www.trustpilot.com', '8.8.8.8', 'sub.domain.co.uk']) {
    assert.doesNotThrow(() => assertSafeUrl(`https://${host}/x`), `${host} should be allowed`);
  }
  assert.equal(isBlockedHost('example.com'), false);
});

// ==================== Redirect re-validation ====================

test('a redirect to the cloud metadata endpoint is blocked', async () => {
  const fetchImpl = scriptedFetch({
    'https://innocent.example/img.png': res(302, { location: 'http://169.254.169.254/computeMetadata/v1/' }),
  });
  await assert.rejects(
    safeFetchRaw('https://innocent.example/img.png', { fetchImpl }),
    /blocked host range|Only HTTPS/
  );
  // Critically: we never issued the request to the metadata service.
  assert.deepEqual(fetchImpl.seen, ['https://innocent.example/img.png']);
});

test('a redirect to https loopback is blocked', async () => {
  const fetchImpl = scriptedFetch({
    'https://innocent.example/a': res(301, { location: 'https://127.0.0.1:8080/admin' }),
  });
  await assert.rejects(safeFetchRaw('https://innocent.example/a', { fetchImpl }), /blocked host range/);
  assert.equal(fetchImpl.seen.length, 1);
});

test('a redirect chain is blocked at whichever hop turns internal', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/1': res(302, { location: 'https://b.example/2' }),
    'https://b.example/2': res(302, { location: 'https://c.example/3' }),
    'https://c.example/3': res(302, { location: 'https://169.254.169.254/' }),
  });
  await assert.rejects(safeFetchRaw('https://a.example/1', { fetchImpl }), /blocked host range/);
  assert.deepEqual(fetchImpl.seen, ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
});

test('a relative redirect is resolved against the current hop and re-checked', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/start': res(302, { location: '/next' }),
    'https://a.example/next': res(200),
  });
  const { response, finalUrl, redirects } = await safeFetchRaw('https://a.example/start', { fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(finalUrl, 'https://a.example/next');
  assert.deepEqual(redirects, ['https://a.example/next']);
});

test('legitimate cross-host redirects still work', async () => {
  const fetchImpl = scriptedFetch({
    'https://short.example/abc': res(302, { location: 'https://cdn.example/image.png' }),
    'https://cdn.example/image.png': res(200, { 'content-type': 'image/png' }),
  });
  const { response, finalUrl } = await safeFetchRaw('https://short.example/abc', { fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(finalUrl, 'https://cdn.example/image.png');
});

test('redirect loops terminate instead of hanging', async () => {
  const fetchImpl = scriptedFetch({
    'https://loop.example/': res(302, { location: 'https://loop.example/' }),
  });
  await assert.rejects(safeFetchRaw('https://loop.example/', { fetchImpl }), /Too many redirects/);
});

test('maxRedirects is respected', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/1': res(302, { location: 'https://a.example/2' }),
    'https://a.example/2': res(302, { location: 'https://a.example/3' }),
    'https://a.example/3': res(200),
  });
  await assert.rejects(
    safeFetchRaw('https://a.example/1', { fetchImpl, maxRedirects: 1 }),
    /Too many redirects/
  );
});

test('redirect: manual is always passed to the underlying fetch', async () => {
  // If this regresses to redirect: 'follow', the platform follows hops for us
  // and assertSafeUrl never sees them again — the original bug.
  let opts = null;
  const fetchImpl = async (_url, o) => { opts = o; return res(200); };
  await safeFetchRaw('https://example.com/', { fetchImpl });
  assert.equal(opts.redirect, 'manual');
});

test('the initial URL is validated before any request is made', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return res(200); };
  await assert.rejects(safeFetchRaw('https://169.254.169.254/', { fetchImpl }), /blocked host range/);
  assert.equal(called, false, 'must not issue the request at all');
});
