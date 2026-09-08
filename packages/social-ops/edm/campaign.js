'use strict';

/**
 * Campaign runner — walks an eligible recipient list through an INJECTED
 * `send` function under a rate limit, a daily cap, a wall-clock budget and a
 * complaint breaker, checkpointing a cursor so a run that stops early can be
 * resumed instead of silently truncated.
 *
 * `send` is whatever the host uses (Resend, SES, SMTP through its own
 * queue). This module holds no provider key and opens no socket.
 */

const { intervalMs } = require('./batch');
const { unsubscribeHeaders } = require('./compliance');

/**
 * @param {object} p
 * @param {Array<{email:string}>} p.recipients          already filtered by audience.filterAudience
 * @param {(r)=>{subject:string,html?:string,text?:string,unsubscribeUrl:string}} p.render
 * @param {(msg)=>Promise<{ok:boolean,messageId?:string,error?:string,retryable?:boolean}>} p.send
 * @param {object} [p.suppression]                    late suppression re-check
 * @param {number} [p.ratePerSec=5]
 * @param {number} [p.dailyCap=Infinity]              e.g. warmupCap(dayIndex)
 * @param {number} [p.alreadySentToday=0]
 * @param {object} [p.breaker]                        createComplaintBreaker()
 * @param {number} [p.budgetMs=240000]                stay under the host's request deadline
 * @param {number} [p.startIndex=0]                   resume cursor
 * @param {{url?:string,mailto?:string}} [p.listUnsubscribe]
 * @param {object} [deps]                             { now, sleep, logger }
 */
async function runEdmCampaign(p = {}, deps = {}) {
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const recipients = p.recipients || [];
  if (typeof p.render !== 'function') throw new Error('runEdmCampaign: render is required');
  if (typeof p.send !== 'function') throw new Error('runEdmCampaign: send is required');
  const rate = p.ratePerSec || 5;
  const gap = intervalMs(rate);
  const dailyCap = p.dailyCap == null ? Infinity : p.dailyCap;
  let sentToday = p.alreadySentToday || 0;
  const budgetMs = p.budgetMs == null ? 240_000 : p.budgetMs;
  const startedAt = now().getTime();
  const headers = p.listUnsubscribe ? unsubscribeHeaders(p.listUnsubscribe) : null;

  const result = { sent: 0, failed: 0, skipped: 0, cursor: p.startIndex || 0, stoppedReason: null, failures: [] };

  for (let i = result.cursor; i < recipients.length; i++) {
    result.cursor = i;
    if (p.breaker && p.breaker.isOpen()) { result.stoppedReason = `breaker_open:${p.breaker.reason()}`; break; }
    if (sentToday >= dailyCap) { result.stoppedReason = 'daily_cap'; break; }
    if (now().getTime() - startedAt > budgetMs) { result.stoppedReason = 'budget_exhausted'; break; }

    const r = recipients[i];
    if (p.suppression && p.suppression.has(r.email)) { result.skipped++; continue; }

    let msg;
    try {
      const rendered = p.render(r);
      if (!rendered || !rendered.subject || (!rendered.html && !rendered.text)) throw new Error('render returned an empty message');
      msg = { to: r.email, subject: rendered.subject, html: rendered.html, text: rendered.text, headers: headers ? { ...headers, ...(rendered.headers || {}) } : rendered.headers };
    } catch (e) {
      result.failed++;
      result.failures.push({ email: r.email, error: `render: ${e.message}` });
      continue;
    }

    let outcome;
    try {
      outcome = await p.send(msg);
    } catch (e) {
      outcome = { ok: false, error: e.message, retryable: true };
    }
    if (outcome && outcome.ok) {
      result.sent++;
      sentToday++;
      if (p.breaker) p.breaker.record({ sent: 1 });
    } else {
      result.failed++;
      result.failures.push({ email: r.email, error: (outcome && outcome.error) || 'send failed', retryable: !!(outcome && outcome.retryable) });
      if (p.breaker && outcome && /bounce/i.test(outcome.error || '')) p.breaker.record({ bounces: 1 });
    }
    if (typeof p.onProgress === 'function') p.onProgress({ index: i, ...result });
    if (i < recipients.length - 1) await sleep(gap);
  }
  if (!result.stoppedReason && result.cursor >= recipients.length - 1) result.cursor = recipients.length;
  result.done = result.cursor >= recipients.length && !result.stoppedReason;
  return result;
}

module.exports = { runEdmCampaign };
