/**
 * RFC822 message-building tests for server/mailbox-oauth-gmail.js.
 *
 * buildRFC822 concatenates the subject and recipient straight into the raw
 * message. Both come from user-editable fields (outreach template, contact
 * record), so a subject of "Hi\r\nBcc: everyone@rival.example" used to inject
 * a real Bcc header into a message we then hand to Gmail's send API — classic
 * email header injection, with our own OAuth token behind it.
 *
 * Also pins the RFC 2047 encoding of non-ASCII subjects (the product ships a
 * full Chinese locale, so this is the normal case, not an edge case).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const gmail = require('../mailbox-oauth-gmail');

/** Everything before the first blank line is the header block. */
function headersOf(raw) {
  return raw.split('\r\n\r\n')[0].split('\r\n');
}
function headerNames(raw) {
  return headersOf(raw)
    .filter(l => !/^[ \t]/.test(l)) // skip folded continuation lines
    .map(l => l.split(':')[0].toLowerCase());
}

const BASE = { to: 'kol@example.com', from: 'Team <team@influencexes.com>', text: 'hello' };

test('CRLF in the subject cannot inject a header', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Collab\r\nBcc: everyone@rival.example' });
  assert.ok(!headerNames(raw).includes('bcc'), 'Bcc must not appear as a header');
  assert.ok(!raw.includes('\r\nBcc:'), raw);
  // The text survives, flattened onto the Subject line.
  assert.match(raw, /Subject: Collab Bcc: everyone@rival\.example/);
});

test('bare LF in the subject cannot inject a header', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Hi\nX-Injected: yes' });
  assert.ok(!headerNames(raw).includes('x-injected'));
});

test('CR alone in the subject cannot inject a header', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Hi\rReply-To: attacker@evil.example' });
  assert.ok(!headerNames(raw).includes('reply-to'));
});

test('CRLF in the recipient cannot inject a header', () => {
  const raw = gmail.buildRFC822({ ...BASE, to: 'a@b.com\r\nBcc: everyone@rival.example' });
  assert.ok(!headerNames(raw).includes('bcc'));
});

test('a subject cannot inject a body or terminate the header block', () => {
  // Two CRLFs would end the headers and start the body — letting an attacker
  // write the whole MIME structure.
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Hi\r\n\r\nInjected body' });
  const names = headerNames(raw);
  assert.deepEqual(names, ['from', 'to', 'subject', 'mime-version', 'content-type']);
});

test('a subject cannot forge a MIME boundary', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Hi\r\n--influx_fake\r\nContent-Type: text/html' });
  assert.ok(!/^--influx_fake/m.test(raw), 'forged boundary line must not exist');
});

test('Unicode line separators are stripped too', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Hi X-Injected: yes ' });
  assert.ok(!headerNames(raw).includes('x-injected'));
});

test('header values are length-capped', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'A'.repeat(5000) });
  const subject = headersOf(raw).find(l => l.startsWith('Subject:'));
  assert.ok(subject.length < 1000, `subject line was ${subject.length} chars`);
});

// ==================== RFC 2047 ====================

test('ASCII subjects are left as plain text', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'Collaboration Opportunity' });
  assert.match(raw, /Subject: Collaboration Opportunity\r\n/);
});

test('non-ASCII subjects are RFC 2047 encoded-words, not raw UTF-8', () => {
  const subject = '合作邀请';
  const raw = gmail.buildRFC822({ ...BASE, subject });
  assert.ok(!raw.includes(subject), 'raw UTF-8 must not appear in the header');
  const line = headersOf(raw).find(l => l.startsWith('Subject:'));
  assert.match(line, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  // ...and it round-trips.
  const b64 = line.match(/=\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), subject);
});

test('long non-ASCII subjects fold into multiple encoded words under 76 chars', () => {
  const subject = '这是一个非常长的中文邮件主题'.repeat(6);
  const raw = gmail.buildRFC822({ ...BASE, subject });
  const headerBlock = raw.split('\r\n\r\n')[0];
  const subjectLines = headerBlock.split('\r\n')
    .slice(headerBlock.split('\r\n').findIndex(l => l.startsWith('Subject:')));
  const words = [];
  for (const line of subjectLines) {
    if (!line.startsWith('Subject:') && !line.startsWith(' ')) break;
    assert.ok(line.length <= 78, `folded line too long (${line.length}): ${line}`);
    const m = line.match(/=\?UTF-8\?B\?([^?]+)\?=/);
    if (m) words.push(Buffer.from(m[1], 'base64'));
  }
  assert.ok(words.length > 1, 'expected the subject to fold');
  assert.equal(Buffer.concat(words).toString('utf8'), subject);
});

test('a non-ASCII display name is encoded but the address is left routable', () => {
  const raw = gmail.buildRFC822({ ...BASE, from: '张三 <me@influencexes.com>', subject: 'x' });
  const line = headersOf(raw).find(l => l.startsWith('From:'));
  assert.match(line, /^From: =\?UTF-8\?B\?[^?]+\?= <me@influencexes\.com>$/);
});

test('comma-separated recipients survive encoding', () => {
  const raw = gmail.buildRFC822({ ...BASE, to: 'One <a@b.com>, 李四 <c@d.com>', subject: 'x' });
  const line = headersOf(raw).find(l => l.startsWith('To:'));
  assert.ok(line.includes('<a@b.com>'), line);
  assert.ok(line.includes('<c@d.com>'), line);
  assert.ok(!line.includes('李四'), 'non-ASCII name must be encoded');
});

// ==================== Body ====================

test('the body is base64-encoded rather than shipped as 8-bit under a 7bit declaration', () => {
  const raw = gmail.buildRFC822({ ...BASE, subject: 'x', text: '你好，世界' });
  assert.ok(!raw.includes('Content-Transfer-Encoding: 7bit'));
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  const parts = raw.split(/--influx_[a-z0-9]+/);
  const plainPart = parts.find(p => p.includes('text/plain'));
  const payload = plainPart.split('\r\n\r\n')[1].trim();
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '你好，世界');
});

test('body content cannot break out of its MIME part', () => {
  // base64 output has no CRLF-delimited attacker-controlled bytes at all.
  const raw = gmail.buildRFC822({ ...BASE, subject: 'x', text: '--influx_guess\r\nContent-Type: text/html\r\n\r\n<script>' });
  assert.ok(!raw.includes('<script>'), 'raw body content must not appear literally');
});

// ==================== Helper units ====================

test('sanitizeHeaderValue handles null/undefined without throwing', () => {
  assert.equal(gmail.sanitizeHeaderValue(null), '');
  assert.equal(gmail.sanitizeHeaderValue(undefined), '');
  assert.equal(gmail.sanitizeHeaderValue(42), '42');
});

test('encodeAddressHeader keeps a bare address untouched', () => {
  assert.equal(gmail.encodeAddressHeader('plain@example.com'), 'plain@example.com');
});
