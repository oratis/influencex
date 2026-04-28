const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const changelog = require('../changelog');

beforeEach(() => changelog._resetCacheForTest());

test('parse: extracts a single dated entry with grouped sections', () => {
  const md = `# Changelog

## 2026-04-28 — Cool stuff

### Added
- One thing
- Two things

### Fixed
- A bug
`;
  const entries = changelog.parse(md);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-04-28');
  assert.equal(entries[0].codename, 'Cool stuff');
  assert.deepEqual(entries[0].added, ['One thing', 'Two things']);
  assert.deepEqual(entries[0].fixed, ['A bug']);
  assert.equal(entries[0].changed.length, 0);
});

test('parse: handles multiple entries newest-first', () => {
  const md = `## 2026-04-28 — A
### Added
- Latest
## 2026-04-20 — B
### Added
- Older
## 2026-04-25 — C
### Added
- Middle
`;
  const entries = changelog.parse(md);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.date), ['2026-04-28', '2026-04-25', '2026-04-20']);
});

test('parse: tolerates entries with no codename', () => {
  const md = `## 2026-04-28
### Added
- Bare entry
`;
  const entries = changelog.parse(md);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].codename, null);
  assert.deepEqual(entries[0].added, ['Bare entry']);
});

test('parse: skips non-dated headings (e.g. preamble)', () => {
  const md = `## How to update
Some prose here.

## 2026-04-28 — Real entry
### Added
- Item
`;
  const entries = changelog.parse(md);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-04-28');
});

test('parse: maps section headings flexibly', () => {
  // "Removed" / "Changed" / "Fixed" with various capitalizations all should
  // land in their canonical buckets.
  const md = `## 2026-04-28 — Variants
### added
- a
### CHANGED
- c
### Fixes
- f
### Removed
- r
`;
  const entries = changelog.parse(md);
  assert.equal(entries[0].added.length, 1);
  assert.equal(entries[0].changed.length, 1);
  assert.equal(entries[0].fixed.length, 1);
  assert.equal(entries[0].removed.length, 1);
});

test('parse: bullets without sections go to notes', () => {
  const md = `## 2026-04-28 — Bare
- Just a thing
- Another thing
`;
  const entries = changelog.parse(md);
  assert.deepEqual(entries[0].notes, ['Just a thing', 'Another thing']);
  assert.equal(entries[0].added.length, 0);
});

test('parse: ignores unknown subsections by folding into notes', () => {
  const md = `## 2026-04-28 — X
### Misc
- one
- two
`;
  const entries = changelog.parse(md);
  assert.deepEqual(entries[0].notes, ['one', 'two']);
});

test('isoDateOrNull: extracts YYYY-MM-DD prefix only', () => {
  assert.equal(changelog.isoDateOrNull('2026-04-28 — codename'), '2026-04-28');
  assert.equal(changelog.isoDateOrNull('2026/04/28'), null);
  assert.equal(changelog.isoDateOrNull(''), null);
  assert.equal(changelog.isoDateOrNull(null), null);
});

test('extractBullets: strips leading dash + whitespace', () => {
  const bullets = changelog.extractBullets(`
- first
  - nested ignored
- second
not a bullet
- third
`);
  assert.deepEqual(bullets, ['first', 'nested ignored', 'second', 'third']);
});

test('parse: empty markdown → empty entries', () => {
  assert.deepEqual(changelog.parse(''), []);
  assert.deepEqual(changelog.parse('no headings here'), []);
});

test('parse: tolerates CRLF line endings', () => {
  const md = '## 2026-04-28 — windows\r\n### Added\r\n- crlf-safe\r\n';
  const entries = changelog.parse(md);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].added, ['crlf-safe']);
});

test('getEntries: reads + parses + caches the real CHANGELOG.md', async () => {
  const e1 = await changelog.getEntries();
  const e2 = await changelog.getEntries(); // hits cache
  assert.equal(e1, e2);
  // Repo's CHANGELOG.md should have at least one dated entry.
  assert.ok(Array.isArray(e1));
});
