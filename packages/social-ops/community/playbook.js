'use strict';

/**
 * Community playbook — the rules that decide whether an OFFICIAL, DISCLOSED
 * account may post promotional content in a community (subreddit, Discord
 * server, forum) right now.
 *
 *   contribute first   ≥ 7 genuine contributions per promotion (7:1)
 *   disclose always    the post carries who you are
 *   respect the room   subreddit rules that forbid self-promotion win
 *   cool down          one promotion per community per N days
 *
 * The ledger is in-memory; the host persists `ledger.snapshot()` and rebuilds
 * with `createContributionLedger(snapshot)`.
 */

const DEFAULTS = Object.freeze({ minRatio: 7, minContributions: 7, cooldownDays: 7 });

function createContributionLedger(snapshot = {}) {
  const communities = new Map(Object.entries(snapshot.communities || {}).map(([k, v]) => [k, { ...v }]));
  function entry(community) {
    const key = String(community).toLowerCase();
    if (!communities.has(key)) communities.set(key, { contributions: 0, promotions: 0, lastPromotionAt: null, lastContributionAt: null });
    return communities.get(key);
  }
  return {
    record(community, kind, at = new Date().toISOString()) {
      const e = entry(community);
      if (kind === 'contribution') { e.contributions++; e.lastContributionAt = at; }
      else if (kind === 'promotion') { e.promotions++; e.lastPromotionAt = at; }
      else throw new Error(`unknown ledger kind: ${kind}`);
      return e;
    },
    get(community) { return { ...entry(community) }; },
    ratio(community) {
      const e = entry(community);
      return e.promotions === 0 ? Infinity : e.contributions / e.promotions;
    },
    snapshot() { return { communities: Object.fromEntries([...communities.entries()].map(([k, v]) => [k, { ...v }])) }; },
  };
}

/**
 * @returns {{allowed:boolean, reason?:string, ratio:number, nextAllowedAt?:string}}
 */
function canPromote(ledger, community, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now || new Date();
  const e = ledger.get(community);
  const ratioAfter = (e.contributions) / (e.promotions + 1);
  if (e.contributions < o.minContributions) {
    return { allowed: false, reason: `contribute first: ${e.contributions}/${o.minContributions} contributions in ${community}`, ratio: ledger.ratio(community) };
  }
  if (ratioAfter < o.minRatio) {
    return { allowed: false, reason: `contribution ratio would drop to ${ratioAfter.toFixed(1)}:1 (< ${o.minRatio}:1)`, ratio: ledger.ratio(community) };
  }
  if (e.lastPromotionAt) {
    const next = new Date(new Date(e.lastPromotionAt).getTime() + o.cooldownDays * 86400_000);
    if (next > now) return { allowed: false, reason: `cooldown: last promotion ${e.lastPromotionAt}`, ratio: ledger.ratio(community), nextAllowedAt: next.toISOString() };
  }
  if (opts.rulesAssessment && opts.rulesAssessment.selfPromotionRestricted) {
    return { allowed: false, reason: `community rules restrict self-promotion: ${opts.rulesAssessment.matchedRules.map((r) => r.shortName).join('; ')}`, ratio: ledger.ratio(community) };
  }
  return { allowed: true, ratio: ledger.ratio(community) };
}

const SELF_PROMO_RE = /self[- ]?promo|no (ads|advertis|promotion|marketing|spam)|no (affiliate|referral)|(not|no) (a )?(place|platform) (for|to) (advertis|promot)|solicit/i;

/** Heuristic read of subreddit / server rules for promotion restrictions. */
function assessCommunityRules(rules = []) {
  const matched = rules.filter((r) => SELF_PROMO_RE.test(`${r.shortName || ''} ${r.description || ''}`));
  return { selfPromotionRestricted: matched.length > 0, matchedRules: matched };
}

const DISCLOSURE_TEMPLATES = Object.freeze({
  en: (brand, role) => `(Disclosure: I ${role ? `am ${role} at` : 'work on'} ${brand}.)`,
  zh: (brand, role) => `（利益相关：本人${role ? `是 ${brand} 的${role}` : `在 ${brand} 工作`}。）`,
});

/** Append a disclosure line if the text does not already carry one. */
function buildDisclosedPost(text, { brand, role, locale = 'en' } = {}) {
  if (!brand) throw new Error('buildDisclosedPost: brand is required');
  const body = String(text || '');
  if (new RegExp(`disclosure|利益相关|${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(team|staff|employee|员工|团队)`, 'i').test(body)) return body;
  const tpl = DISCLOSURE_TEMPLATES[locale] || DISCLOSURE_TEMPLATES.en;
  return `${body.trimEnd()}\n\n${tpl(brand, role)}`;
}

module.exports = { DEFAULTS, createContributionLedger, canPromote, assessCommunityRules, buildDisclosedPost, SELF_PROMO_RE };
