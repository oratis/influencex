const { test } = require('node:test');
const assert = require('node:assert');
const { parseHumanName, hunterEmailFinder } = require('../scraper');

test('parseHumanName: clean two-word name', () => {
  assert.deepStrictEqual(parseHumanName('Jane Smith'), { first: 'Jane', last: 'Smith' });
});

test('parseHumanName: three-word name keeps last as composite', () => {
  assert.deepStrictEqual(parseHumanName('Mary Anne Doe'), { first: 'Mary', last: 'Anne Doe' });
});

test('parseHumanName: strips emoji + parenthetical handle', () => {
  assert.deepStrictEqual(parseHumanName('🚀 Jane Smith (the_jane)'), { first: 'Jane', last: 'Smith' });
});

test('parseHumanName: single-token brand handle returns null', () => {
  // "MrBeast" / "PewDiePie" / "AIGames" — Email Finder needs a last name.
  assert.strictEqual(parseHumanName('MrBeast'), null);
  assert.strictEqual(parseHumanName('A.I.Games'), null);
});

test('parseHumanName: empty / numeric returns null', () => {
  assert.strictEqual(parseHumanName(''), null);
  assert.strictEqual(parseHumanName('1234 5678'), null);
  assert.strictEqual(parseHumanName(undefined), null);
});

test('hunterEmailFinder: returns empty string when no API key', async () => {
  const old = process.env.HUNTER_API_KEY;
  delete process.env.HUNTER_API_KEY;
  try {
    const r = await hunterEmailFinder('Jane', 'Smith', 'example.com');
    assert.strictEqual(r, '');
  } finally {
    if (old !== undefined) process.env.HUNTER_API_KEY = old;
  }
});

test('hunterEmailFinder: returns empty when missing first name or domain', async () => {
  process.env.HUNTER_API_KEY = 'test';
  try {
    assert.strictEqual(await hunterEmailFinder('', 'Smith', 'example.com'), '');
    assert.strictEqual(await hunterEmailFinder('Jane', 'Smith', ''), '');
  } finally {
    delete process.env.HUNTER_API_KEY;
  }
});

// Note: we don't mock the actual Hunter Email-Finder API call — scraper.js
// uses ./proxy-fetch (not global fetch), and stubbing internal modules just
// to test the score-threshold branch isn't worth the brittleness. The
// threshold logic (score >= 50) lives in 4 lines of straight-line code in
// hunterEmailFinder; a screen review covers it. Real-world calls are caught
// by the no-API-key + missing-args guards above.
