'use strict';

/**
 * Sending discipline — warm-up caps for a new domain, a complaint/bounce
 * circuit breaker, and batch/throttle arithmetic. Pure functions plus one
 * tiny state machine; the host persists the breaker state between runs.
 */

/** Daily caps for a fresh sending domain/IP; index = days since first send. */
const DEFAULT_WARMUP = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]);

function warmupCap(dayIndex, schedule = DEFAULT_WARMUP) {
  if (dayIndex == null || dayIndex < 0) return schedule[0];
  if (dayIndex >= schedule.length) return Infinity;
  return schedule[dayIndex];
}

/** Days since the first send (UTC), for warmupCap. */
function warmupDayIndex(firstSendAt, now = new Date()) {
  if (!firstSendAt) return 0;
  const ms = now.getTime() - new Date(firstSendAt).getTime();
  return Math.max(0, Math.floor(ms / 86400_000));
}

/**
 * Circuit breaker on complaint + bounce rates. Gmail's published ceiling is
 * 0.3% spam rate (0.1% target); we trip at 0.1% complaints / 2% bounces by
 * default once there is a meaningful sample.
 */
function createComplaintBreaker(opts = {}) {
  const state = {
    sent: opts.sent || 0,
    complaints: opts.complaints || 0,
    bounces: opts.bounces || 0,
    open: !!opts.open,
    openedReason: opts.openedReason || null,
  };
  const complaintThreshold = opts.complaintRateThreshold ?? 0.001;
  const bounceThreshold = opts.bounceRateThreshold ?? 0.02;
  const minSample = opts.minSample ?? 200;

  function evaluate() {
    if (state.sent < minSample) return state;
    const cr = state.complaints / state.sent;
    const br = state.bounces / state.sent;
    if (cr > complaintThreshold) { state.open = true; state.openedReason = `complaint rate ${(cr * 100).toFixed(2)}% > ${(complaintThreshold * 100).toFixed(2)}%`; }
    else if (br > bounceThreshold) { state.open = true; state.openedReason = `bounce rate ${(br * 100).toFixed(2)}% > ${(bounceThreshold * 100).toFixed(2)}%`; }
    return state;
  }
  return {
    record({ sent = 0, complaints = 0, bounces = 0 } = {}) {
      state.sent += sent; state.complaints += complaints; state.bounces += bounces;
      return evaluate();
    },
    isOpen() { return state.open; },
    reason() { return state.openedReason; },
    reset() { state.open = false; state.openedReason = null; return state; },
    snapshot() { return { ...state }; },
    rates() { return state.sent ? { complaintRate: state.complaints / state.sent, bounceRate: state.bounces / state.sent } : { complaintRate: 0, bounceRate: 0 }; },
  };
}

function splitBatches(items, size) {
  if (!size || size < 1) throw new Error('batch size must be >= 1');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Milliseconds to wait between sends to hold `ratePerSec` on average. */
function intervalMs(ratePerSec) {
  if (!ratePerSec || ratePerSec <= 0) throw new Error('ratePerSec must be > 0');
  return Math.ceil(1000 / ratePerSec);
}

module.exports = { DEFAULT_WARMUP, warmupCap, warmupDayIndex, createComplaintBreaker, splitBatches, intervalMs };
