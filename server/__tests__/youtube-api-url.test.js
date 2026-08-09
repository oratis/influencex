/**
 * YouTube Data API v3 URL construction.
 *
 * Regression guard for query-parameter injection: `handle`, `customName` and
 * `channelId` are all parsed out of a user-submitted profile URL, so a handle
 * like `abc&part=contentDetails` used to append a second `part=` parameter to
 * an authenticated, quota-metered API call (and `abc#` truncated the URL,
 * dropping our API key). See server/youtube-api.js.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { youtubeApiUrl } = require('../youtube-api');

// --- helpers ---------------------------------------------------------------

function paramsOf(url) {
  return new URL(url).searchParams;
}

/** All values for a repeated key, so we can assert a param appears exactly once. */
function countKey(url, key) {
  return [...paramsOf(url).keys()].filter(k => k === key).length;
}

// --- builder ---------------------------------------------------------------

test('youtubeApiUrl: hostile handle cannot inject a second `part` parameter', () => {
  const url = youtubeApiUrl('channels', {
    part: 'id',
    forHandle: 'abc&part=contentDetails',
    key: 'test-key',
  });

  assert.strictEqual(countKey(url, 'part'), 1, 'exactly one part= parameter');
  assert.strictEqual(paramsOf(url).get('part'), 'id');
  // The whole hostile string survives intact as one opaque value.
  assert.strictEqual(paramsOf(url).get('forHandle'), 'abc&part=contentDetails');
  assert.strictEqual(paramsOf(url).get('key'), 'test-key');
  assert.ok(url.includes('abc%26part%3DcontentDetails'), 'the & and = are percent-encoded');
});

test('youtubeApiUrl: hostile handle cannot shadow the API key', () => {
  const url = youtubeApiUrl('channels', {
    part: 'id',
    forHandle: 'abc&key=attacker-key',
    key: 'real-key',
  });

  assert.strictEqual(countKey(url, 'key'), 1);
  assert.strictEqual(paramsOf(url).get('key'), 'real-key');
});

test('youtubeApiUrl: `#` cannot truncate the query string', () => {
  const url = youtubeApiUrl('channels', { part: 'id', forHandle: 'abc#', key: 'real-key' });

  // Raw interpolation put `key=` into the fragment, so it never reached Google.
  assert.strictEqual(new URL(url).hash, '', 'no fragment');
  assert.strictEqual(paramsOf(url).get('key'), 'real-key');
  assert.strictEqual(paramsOf(url).get('forHandle'), 'abc#');
});

test('youtubeApiUrl: array values become a comma list with each element encoded', () => {
  const url = youtubeApiUrl('videos', {
    part: ['snippet', 'statistics'],
    id: ['vid1', 'vid2&part=contentDetails'],
    key: 'test-key',
  });

  // Literal comma separators (the Data API's list syntax) survive...
  assert.ok(url.includes('part=snippet,statistics'), 'part list uses literal commas');
  assert.strictEqual(countKey(url, 'part'), 1);
  // ...but an element cannot smuggle in a separator or a new parameter.
  assert.strictEqual(paramsOf(url).get('id'), 'vid1,vid2&part=contentDetails');
  assert.ok(url.includes('vid2%26part%3DcontentDetails'));
});

test('youtubeApiUrl: empty and nullish values are dropped, not stringified', () => {
  const url = youtubeApiUrl('channels', {
    part: 'id',
    id: 'UC123',
    key: undefined,      // missing YOUTUBE_API_KEY used to serialise as "undefined"
    forHandle: null,
    order: '',
  });

  assert.strictEqual(paramsOf(url).has('key'), false);
  assert.strictEqual(paramsOf(url).has('forHandle'), false);
  assert.strictEqual(paramsOf(url).has('order'), false);
  assert.strictEqual(paramsOf(url).get('id'), 'UC123');
});

test('youtubeApiUrl: targets the fixed Data API v3 host', () => {
  const url = youtubeApiUrl('search', { q: 'cats' });
  assert.strictEqual(new URL(url).origin, 'https://www.googleapis.com');
  assert.strictEqual(new URL(url).pathname, '/youtube/v3/search');
});

// --- real call path --------------------------------------------------------
// The builder being safe only matters if scrapeYouTube actually routes through
// it, so drive the real function with a stubbed ./proxy-fetch and inspect the
// URLs it puts on the wire. node --test runs each file in its own process, so
// poking require.cache here cannot leak into other test files.
//
// Note on the payload: the handle is extracted with /@([^/?&]+)/, so `&` is
// already stripped before it reaches the URL. `#` is *not* in that character
// class — and under raw interpolation `#` was the worse one, since it turned
// the rest of the query (including `&key=`) into a URL fragment that never
// reached Google. The video ids below have no such filter: they come straight
// off the API response and used to be joined in unencoded.

test('scrapeYouTube: a hostile @handle cannot truncate or inject parameters', async () => {
  const requested = [];

  const proxyFetchPath = require.resolve('../proxy-fetch');
  const stub = async (url) => {
    requested.push(url);
    const { pathname, searchParams } = new URL(url);

    if (pathname.endsWith('/channels') && searchParams.has('forHandle')) {
      return { json: async () => ({ items: [{ id: 'UC_resolved' }] }) };
    }
    if (pathname.endsWith('/channels')) {
      return {
        json: async () => ({
          items: [{
            // Empty description keeps discoverEmail from making network calls.
            snippet: { title: 'Test Channel', description: '', thumbnails: {} },
            statistics: { subscriberCount: '1000', viewCount: '5000', videoCount: '10' },
          }],
        }),
      };
    }
    if (pathname.endsWith('/search')) {
      // A video id carrying an injection payload — it reaches the videos.list
      // call below as an array element.
      return { json: async () => ({ items: [{ id: { videoId: 'vid1&part=contentDetails' } }] }) };
    }
    if (pathname.endsWith('/videos')) {
      return {
        json: async () => ({
          items: [{ statistics: { viewCount: '100', likeCount: '10', commentCount: '5' } }],
        }),
      };
    }
    return { json: async () => ({ items: [] }) };
  };

  const original = require.cache[proxyFetchPath];
  require.cache[proxyFetchPath] = new Module(proxyFetchPath, null);
  require.cache[proxyFetchPath].filename = proxyFetchPath;
  require.cache[proxyFetchPath].loaded = true;
  require.cache[proxyFetchPath].exports = stub;

  const oldKey = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'secret-api-key';

  try {
    // scraper.js reads YOUTUBE_API_KEY and requires ./proxy-fetch at load time,
    // so require it only after both are in place.
    const { scrapeYouTube } = require('../scraper');

    const result = await scrapeYouTube(
      'https://www.youtube.com/@abc#part=contentDetails',
      'abc',
    );

    assert.strictEqual(result.success, true, `scrape failed: ${result.error}`);
    assert.ok(requested.length >= 2, 'made at least the resolve + details calls');

    for (const url of requested) {
      assert.strictEqual(countKey(url, 'part'), 1, `exactly one part= in ${url}`);
      assert.strictEqual(countKey(url, 'key'), 1, `exactly one key= in ${url}`);
      assert.strictEqual(paramsOf(url).get('key'), 'secret-api-key', `API key intact in ${url}`);
      assert.strictEqual(new URL(url).hash, '', `no fragment in ${url}`);
      assert.strictEqual(new URL(url).origin, 'https://www.googleapis.com');
    }

    // The handle is carried as one opaque value, not as extra parameters, and
    // the `#` no longer swallows `&key=...` into a fragment.
    const resolveCall = requested.find(u => paramsOf(u).has('forHandle'));
    assert.ok(resolveCall, 'used the cheap forHandle lookup');
    assert.strictEqual(paramsOf(resolveCall).get('forHandle'), 'abc#part=contentDetails');
    assert.strictEqual(paramsOf(resolveCall).get('part'), 'id');
    assert.ok(resolveCall.includes('abc%23part%3DcontentDetails'), 'the # and = are encoded');

    // API-supplied video ids are encoded too — they flow into videos.list as a
    // comma list and must not be able to add parameters either.
    const videosCall = requested.find(u => new URL(u).pathname.endsWith('/videos'));
    assert.ok(videosCall, 'fetched video statistics');
    assert.strictEqual(paramsOf(videosCall).get('id'), 'vid1&part=contentDetails');
    assert.strictEqual(paramsOf(videosCall).get('part'), 'statistics');
  } finally {
    if (original) require.cache[proxyFetchPath] = original;
    else delete require.cache[proxyFetchPath];
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
  }
});
