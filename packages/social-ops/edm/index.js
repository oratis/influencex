'use strict';

/**
 * EDM (email direct marketing) capability — on an OWNED sending domain,
 * through the host's ESP, to people who agreed to hear from you.
 *
 * What is deliberately absent: mailbox provisioning, list purchase/scrape
 * import, header spoofing, "warm-up bots". See ../refusals.js.
 */

const compliance = require('./compliance');
const suppression = require('./suppression');
const audience = require('./audience');
const batch = require('./batch');
const campaign = require('./campaign');

module.exports = {
  ...compliance,
  ...suppression,
  ...audience,
  ...batch,
  ...campaign,
};
