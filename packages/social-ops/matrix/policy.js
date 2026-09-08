'use strict';

/**
 * Account-matrix policy — the legitimate shape of "many accounts":
 * several OWNED accounts, each with a named human holder, a disclosed
 * relationship to the brand, and its own platform-granted authorisation.
 *
 * validateAccountProfile() is the gate every account must pass before a host
 * stores it. It rejects, by construction, the shapes that describe a bot
 * farm: generated identities, proxy pools, shared device fingerprints,
 * "kind: bot". planStagger() then spreads a batch of posts across the matrix
 * without the burst pattern platforms flag as coordination.
 */

const { getPlatform } = require('../capabilities');

const ACCOUNT_KINDS = Object.freeze(['brand_main', 'brand_regional', 'brand_topic', 'employee', 'creator_partner']);
const AUTHORIZATIONS = Object.freeze(['oauth_consent', 'platform_app_credential', 'bot_token', 'webhook']);
const REFUSED_KINDS = new Set(['bot', 'sockpuppet', 'farm', 'burner', 'alt', 'fake', 'persona', 'synthetic']);
const REFUSED_FLAGS = ['proxyPool', 'proxy_pool', 'generatedIdentity', 'generated_identity', 'deviceFarm', 'device_farm', 'sharedFingerprint', 'autoRegistered', 'auto_registered'];

/**
 * @param {object} profile { platform, kind, handle, holder: {name, contact}, disclosure, authorization, externalId? }
 */
function validateAccountProfile(profile = {}) {
  const errors = [];
  const platform = getPlatform(profile.platform);
  if (!platform) errors.push(`unknown platform: ${profile.platform}`);
  const kind = String(profile.kind || '').toLowerCase();
  if (REFUSED_KINDS.has(kind)) errors.push(`refused: account kind "${profile.kind}" describes an inauthentic account (see refusals.bot_account_farms)`);
  else if (!ACCOUNT_KINDS.includes(kind)) errors.push(`kind must be one of ${ACCOUNT_KINDS.join(', ')}`);
  for (const flag of REFUSED_FLAGS) {
    if (profile[flag]) errors.push(`refused: ${flag} is not a supported account property`);
  }
  if (!profile.handle) errors.push('handle is required');
  if (!profile.holder || !profile.holder.name) errors.push('holder.name (the human who controls the account) is required');
  if (!profile.disclosure || String(profile.disclosure).trim().length < 8) errors.push('disclosure (how the account identifies its relationship to the brand, shown in bio/posts) is required');
  if (!AUTHORIZATIONS.includes(profile.authorization)) errors.push(`authorization must be one of ${AUTHORIZATIONS.join(', ')} — granted by the holder, never by automation`);
  if (kind === 'creator_partner' && !profile.agreementRef) errors.push('creator_partner accounts need agreementRef (the signed collaboration / FTC-disclosure agreement)');
  return { ok: errors.length === 0, errors };
}

/** Per-platform daily cap from the capability matrix (host may lower it). */
function dailyCapFor(platformId, override) {
  const p = getPlatform(platformId);
  const cap = p && p.limits && p.limits.perDay != null ? p.limits.perDay : 5;
  return override != null ? Math.min(cap, override) : cap;
}

/**
 * Spread `items` over `accounts` (same platform) with a minimum gap per
 * account and a daily cap per account. Round-robin, deterministic.
 *
 * @returns {{assignments: Array<{item, accountId, scheduledAt}>, unscheduled: Array}}
 */
function planStagger(items = [], accounts = [], opts = {}) {
  const minGapMs = (opts.minGapMinutes == null ? 30 : opts.minGapMinutes) * 60_000;
  const start = opts.startAt ? new Date(opts.startAt) : new Date();
  const jitterMs = (opts.jitterMinutes || 0) * 60_000;
  const rng = typeof opts.random === 'function' ? opts.random : Math.random;
  const state = accounts.map((a) => ({ id: a.id, platform: a.platform, next: start.getTime(), count: 0, cap: dailyCapFor(a.platform, opts.perAccountDailyCap) }));
  const assignments = [];
  const unscheduled = [];
  let idx = 0;
  for (const item of items) {
    let placed = false;
    for (let tries = 0; tries < state.length; tries++) {
      const s = state[(idx + tries) % state.length];
      if (s.count >= s.cap) continue;
      const at = s.next + (jitterMs ? Math.floor(rng() * jitterMs) : 0);
      assignments.push({ item, accountId: s.id, scheduledAt: new Date(at).toISOString() });
      s.next = at + minGapMs;
      s.count++;
      idx = (idx + tries + 1) % state.length;
      placed = true;
      break;
    }
    if (!placed) unscheduled.push(item);
  }
  return { assignments, unscheduled };
}

module.exports = { ACCOUNT_KINDS, AUTHORIZATIONS, validateAccountProfile, dailyCapFor, planStagger };
