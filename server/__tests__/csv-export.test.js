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
