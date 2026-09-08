'use strict';

/**
 * Suppression list — addresses that must never receive marketing mail again,
 * whatever any audience query says. Built from provider events (unsubscribe,
 * hard bounce, complaint) and manual blocks; a host persists the entries and
 * rebuilds the set at send time.
 */

const REASONS = Object.freeze(['unsubscribed', 'bounced', 'complained', 'blocked', 'invalid']);

function normalizeEmail(address) {
  return String(address || '').trim().toLowerCase();
}

function createSuppressionList(initial = []) {
  const map = new Map();
  const list = {
    add(address, reason = 'blocked', at = null) {
      const key = normalizeEmail(address);
      if (!key) return list;
      if (!REASONS.includes(reason)) throw new Error(`unknown suppression reason: ${reason}`);
      // Never downgrade: a complaint outranks a soft block.
      const prev = map.get(key);
      if (!prev || rank(reason) >= rank(prev.reason)) map.set(key, { reason, at });
      return list;
    },
    has(address) {
      return map.has(normalizeEmail(address));
    },
    reason(address) {
      const e = map.get(normalizeEmail(address));
      return e ? e.reason : null;
    },
    get size() {
      return map.size;
    },
    entries() {
      return [...map.entries()].map(([email, v]) => ({ email, ...v }));
    },
  };
  for (const e of initial) {
    if (typeof e === 'string') list.add(e);
    else if (e && e.email) list.add(e.email, e.reason || 'blocked', e.at || null);
  }
  return list;
}

function rank(reason) {
  return { invalid: 1, blocked: 2, bounced: 3, unsubscribed: 4, complained: 5 }[reason] || 0;
}

/** Map provider webhook events to suppression entries. Soft bounces do not suppress. */
function suppressionFromEvents(events = []) {
  const list = createSuppressionList();
  for (const ev of events) {
    const email = ev.email || ev.to || (ev.data && ev.data.to);
    if (!email) continue;
    const type = String(ev.type || ev.event_type || '').toLowerCase().replace(/^email\./, '');
    if (type === 'unsubscribed' || type === 'unsubscribe') list.add(email, 'unsubscribed', ev.at || null);
    else if (type === 'complained' || type === 'complaint' || type === 'spam') list.add(email, 'complained', ev.at || null);
    else if (type === 'bounced' || type === 'bounce') {
      const hard = ev.bounceType ? /hard|permanent/i.test(ev.bounceType) : !/soft|transient/i.test(ev.reason || '');
      if (hard) list.add(email, 'bounced', ev.at || null);
    } else if (type === 'blocked') list.add(email, 'blocked', ev.at || null);
  }
  return list;
}

module.exports = { createSuppressionList, suppressionFromEvents, normalizeEmail, REASONS };
