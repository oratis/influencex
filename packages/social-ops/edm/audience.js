'use strict';

/**
 * Audience eligibility — who may receive THIS campaign.
 *
 * A recipient is eligible only with a consent basis the host recorded:
 *   explicit      the person opted in (ticked an unticked box, confirmed a
 *                 double opt-in) — valid everywhere
 *   soft_opt_in   existing customer, similar products, opt-out offered at
 *                 collection (PECR reg. 22 / CAN-SPAM) — NOT valid in the
 *                 EEA/UK/CH for non-customers and never for purchased lists
 *   none          no basis — never eligible
 *
 * Purchased, scraped or "found" addresses have no consent basis and are
 * rejected here regardless of what field the host puts them in. This is the
 * module that makes the "register lots of mailboxes and blast" request
 * structurally impossible to express.
 */

const { EMAIL_RE } = require('./compliance');
const { normalizeEmail } = require('./suppression');

const EXPLICIT_CONSENT_REGIONS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH', 'CA', // CASL is opt-in too
]);

const CONSENT = Object.freeze(['explicit', 'soft_opt_in', 'none']);
const REJECTED_SOURCES = new Set(['purchased', 'scraped', 'harvested', 'generated', 'appended', 'rented']);

/**
 * @param {Array<{email:string, consent?:string, region?:string, existingCustomer?:boolean, unsubscribedAt?:string|null, source?:string, consentAt?:string}>} recipients
 * @param {object} [opts]  { suppression?, requireExplicitRegions?: Set, maxConsentAgeDays?: number, now?: Date }
 */
function filterAudience(recipients = [], opts = {}) {
  const suppression = opts.suppression;
  const explicitRegions = opts.requireExplicitRegions || EXPLICIT_CONSENT_REGIONS;
  const now = opts.now || new Date();
  const maxAgeMs = opts.maxConsentAgeDays ? opts.maxConsentAgeDays * 86400_000 : null;
  const seen = new Set();
  const eligible = [];
  const excluded = [];

  for (const r of recipients) {
    const email = normalizeEmail(r && r.email);
    const reject = (reason) => excluded.push({ email: email || (r && r.email) || null, reason });
    if (!email || !EMAIL_RE.test(email)) { reject('invalid_email'); continue; }
    if (seen.has(email)) { reject('duplicate'); continue; }
    seen.add(email);
    if (r.source && REJECTED_SOURCES.has(String(r.source).toLowerCase())) { reject(`no_consent_basis:${r.source}`); continue; }
    if (r.unsubscribedAt) { reject('unsubscribed'); continue; }
    if (suppression && suppression.has(email)) { reject(`suppressed:${suppression.reason(email)}`); continue; }
    const consent = r.consent || 'none';
    if (!CONSENT.includes(consent)) { reject(`unknown_consent:${consent}`); continue; }
    if (consent === 'none') { reject('no_consent'); continue; }
    const region = r.region ? String(r.region).toUpperCase() : null;
    if (consent === 'soft_opt_in') {
      if (!r.existingCustomer) { reject('soft_opt_in_requires_existing_customer'); continue; }
      if (region && explicitRegions.has(region)) { reject(`explicit_consent_required:${region}`); continue; }
    }
    if (maxAgeMs && r.consentAt) {
      const age = now.getTime() - new Date(r.consentAt).getTime();
      if (Number.isFinite(age) && age > maxAgeMs) { reject('consent_stale'); continue; }
    }
    eligible.push({ ...r, email });
  }
  return { eligible, excluded, stats: { input: recipients.length, eligible: eligible.length, excluded: excluded.length } };
}

module.exports = { filterAudience, EXPLICIT_CONSENT_REGIONS, CONSENT, REJECTED_SOURCES };
