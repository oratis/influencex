const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderTemplate,
  renderEmail,
  suggestTemplate,
  listTemplates,
  formatFollowers,
  DEFAULT_TEMPLATES,
} = require('../email-templates');

test('renderTemplate: substitutes {{variables}}', () => {
  const result = renderTemplate('Hello {{name}}!', { name: 'World' });
  assert.equal(result, 'Hello World!');
});

test('renderTemplate: handles multiple occurrences', () => {
  const result = renderTemplate('{{a}} and {{a}} again', { a: 'X' });
  assert.equal(result, 'X and X again');
});

test('renderTemplate: missing variables become empty string', () => {
  const result = renderTemplate('Hello {{name}}, {{missing}}', { name: 'World' });
  assert.equal(result, 'Hello World, ');
});

test('renderTemplate: null and undefined values become empty', () => {
  const result = renderTemplate('{{a}}-{{b}}-{{c}}', { a: null, b: undefined, c: 'ok' });
  assert.equal(result, '--ok');
});

test('renderTemplate: non-string values are coerced to string', () => {
  const result = renderTemplate('Count: {{n}}', { n: 42 });
  assert.equal(result, 'Count: 42');
});

test('renderTemplate: empty/null template returns empty', () => {
  assert.equal(renderTemplate('', { a: 'x' }), '');
  assert.equal(renderTemplate(null, { a: 'x' }), '');
  assert.equal(renderTemplate(undefined, { a: 'x' }), '');
});

test('renderEmail: returns subject + body', () => {
  const rendered = renderEmail('outreach-affiliate-en', {
    kol_name: 'Alice',
    platform: 'YouTube',
    followers: '10K',
    category: 'gaming',
    sender_name: 'Bob',
    product_name: 'TestBrand',
  });
  assert.ok(rendered.subject.includes('TestBrand'));
  assert.ok(rendered.subject.includes('Alice'));
  assert.ok(rendered.body.includes('Alice'));
  assert.ok(rendered.body.includes('YouTube'));
  assert.ok(rendered.body.includes('gaming'));
  assert.ok(rendered.body.includes('Bob'));
});

test('renderEmail: throws for unknown template id', () => {
  assert.throws(() => renderEmail('does-not-exist', {}), /Template not found/);
});

test('suggestTemplate: returns affiliate EN template for default', () => {
  const t = suggestTemplate({ cooperation_type: 'affiliate', language: 'en' });
  assert.equal(t.id, 'outreach-affiliate-en');
});

test('suggestTemplate: returns paid EN template when requested', () => {
  const t = suggestTemplate({ cooperation_type: 'paid', language: 'en' });
  assert.equal(t.id, 'outreach-paid-en');
});

test('suggestTemplate: returns Chinese template when language is zh', () => {
  const t = suggestTemplate({ cooperation_type: 'affiliate', language: 'zh' });
  assert.equal(t.language, 'zh');
});

test('listTemplates: returns array of template metadata', () => {
  const templates = listTemplates();
  assert.ok(Array.isArray(templates));
  assert.ok(templates.length >= 4);
  for (const t of templates) {
    assert.ok(t.id);
    assert.ok(t.name);
    assert.ok(t.subject);
    assert.ok(t.language);
  }
});

test('formatFollowers: compacts large numbers', () => {
  assert.equal(formatFollowers(1500), '1.5K');
  assert.equal(formatFollowers(1200000), '1.2M');
  assert.equal(formatFollowers(500), '500');
});

test('formatFollowers: handles zero and falsy', () => {
  assert.equal(formatFollowers(0), '0');
  assert.equal(formatFollowers(null), '');
  assert.equal(formatFollowers(undefined), '');
});

test('DEFAULT_TEMPLATES includes all expected ids', () => {
  assert.ok(DEFAULT_TEMPLATES['outreach-affiliate-en']);
  assert.ok(DEFAULT_TEMPLATES['outreach-paid-en']);
  assert.ok(DEFAULT_TEMPLATES['follow-up-en']);
  assert.ok(DEFAULT_TEMPLATES['outreach-affiliate-zh']);
});
