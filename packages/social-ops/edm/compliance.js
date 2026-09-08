'use strict';

/**
 * EDM compliance checks — the floor a bulk campaign must clear before a
 * single message leaves. Encodes the parts of CAN-SPAM (15 U.S.C. §7704),
 * GDPR/ePrivacy (consent + Art. 21 objection), CASL, and the 2024 Gmail/Yahoo
 * bulk-sender requirements (authenticated domain, one-click unsubscribe, spam
 * rate < 0.3%) that can be checked statically. It cannot check consent — that
 * is audience.js's job — and it does not send anything.
 */

/** Consumer mailbox providers: never a legitimate bulk sending identity. */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.jp', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'qq.com', 'foxmail.com', '163.com', '126.com',
  'yeah.net', 'sina.com', 'sohu.com', 'aliyun.com', 'naver.com', 'daum.net', 'mail.ru', 'yandex.ru', 'gmx.com', 'gmx.de', 'web.de',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainOf(address) {
  const m = String(address || '').toLowerCase().match(/@([^>\s]+)/);
  return m ? m[1] : null;
}

/**
 * @param {object} c
 * @param {{address:string,name?:string}} c.from
 * @param {string} [c.replyTo]
 * @param {string} c.subject
 * @param {string} [c.html]
 * @param {string} [c.text]
 * @param {string} c.unsubscribeUrl           must appear in the body
 * @param {string} c.physicalAddress          postal address that must appear in the body
 * @param {{url?:string,mailto?:string}} [c.listUnsubscribe]   RFC 2369 header values
 * @param {boolean} [c.oneClickUnsubscribe]   RFC 8058 List-Unsubscribe-Post
 * @param {boolean} [c.bulk=true]             >= 5,000/day class sender
 * @param {object} [c.auth]                   { spf: bool|null, dkim: bool|null, dmarc: 'none'|'quarantine'|'reject'|null }
 * @param {boolean} [c.isReply=false]         subject may start with Re:/Fwd: only for real replies
 */
function checkCampaignCompliance(c = {}) {
  const errors = [];
  const warnings = [];
  const from = (c.from && c.from.address) || '';
  const fromDomain = domainOf(from);

  if (!EMAIL_RE.test(from)) errors.push('from.address must be a valid email address');
  if (fromDomain && CONSUMER_MAIL_DOMAINS.has(fromDomain)) errors.push(`from.address is on a consumer mailbox domain (${fromDomain}); bulk mail must come from an owned domain with SPF/DKIM/DMARC`);
  if (c.from && !c.from.name) warnings.push('from.name is empty; recipients see a bare address');
  if (c.replyTo && !EMAIL_RE.test(c.replyTo)) errors.push('replyTo must be a valid email address');

  const subject = String(c.subject || '');
  if (!subject.trim()) errors.push('subject is required');
  if (!c.isReply && /^\s*(re|fw|fwd|aw|wg)\s*:/i.test(subject)) errors.push('subject imitates a reply/forward (deceptive header, CAN-SPAM §5(a)(2))');
  if (/[!]{3,}|\b(100% free|act now|winner|urgent!!)\b/i.test(subject)) warnings.push('subject uses spam-trigger phrasing');

  const body = `${c.html || ''}\n${c.text || ''}`;
  if (!c.html && !c.text) errors.push('html or text body is required');
  if (!c.unsubscribeUrl) errors.push('unsubscribeUrl is required');
  else if (!body.includes(c.unsubscribeUrl)) errors.push('unsubscribeUrl does not appear in the body (recipients must be able to opt out from the message itself)');
  if (!c.physicalAddress) errors.push('physicalAddress is required (valid postal address, CAN-SPAM §5(a)(5)(A)(iii))');
  else if (!body.includes(c.physicalAddress)) errors.push('physicalAddress does not appear in the body');
  if (c.text && !c.html) warnings.push('text-only body; a multipart alternative improves deliverability');

  const bulk = c.bulk !== false;
  const lu = c.listUnsubscribe || {};
  if (bulk) {
    if (!lu.url && !lu.mailto) errors.push('List-Unsubscribe header (url and/or mailto) is required for bulk senders');
    if (!c.oneClickUnsubscribe) errors.push('one-click unsubscribe (List-Unsubscribe-Post: List-Unsubscribe=One-Click, RFC 8058) is required for bulk senders since 2024');
  } else if (!lu.url && !lu.mailto) {
    warnings.push('no List-Unsubscribe header');
  }

  const auth = c.auth || {};
  if (auth.spf === false) errors.push('SPF is not passing for the sending domain');
  if (auth.dkim === false) errors.push('DKIM is not signing for the sending domain');
  if (auth.dmarc === null || auth.dmarc === undefined) warnings.push('DMARC policy unknown; bulk senders need at least p=none');
  else if (!['none', 'quarantine', 'reject'].includes(auth.dmarc)) errors.push(`invalid dmarc policy "${auth.dmarc}"`);
  if (auth.spf == null || auth.dkim == null) warnings.push('SPF/DKIM status unknown; verify DNS before the first send');

  if (c.html && /<script[\s>]/i.test(c.html)) errors.push('html contains <script>');
  if (c.html && /<form[\s>]/i.test(c.html)) warnings.push('html contains <form>; most clients strip it');

  return { ok: errors.length === 0, errors, warnings, fromDomain };
}

/** Headers a host should set on every bulk message (RFC 2369 + RFC 8058). */
function unsubscribeHeaders({ url, mailto } = {}) {
  const parts = [];
  if (mailto) parts.push(`<mailto:${mailto}>`);
  if (url) parts.push(`<${url}>`);
  if (!parts.length) throw new Error('unsubscribeHeaders: url or mailto is required');
  return { 'List-Unsubscribe': parts.join(', '), 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

module.exports = { checkCampaignCompliance, unsubscribeHeaders, CONSUMER_MAIL_DOMAINS, EMAIL_RE, domainOf };
