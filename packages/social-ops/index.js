'use strict';

/**
 * @influencex/social-ops — public entry.
 *
 * Two ways to use it:
 *
 *   // 1. static modules (credentials + deps on every call)
 *   const so = require('@influencex/social-ops');
 *   await so.connectors.getConnector('x').publish({ accessToken }, { text }, { fetch });
 *
 *   // 2. a bound instance (deps once)
 *   const ops = so.createSocialOps({ fetch: proxyFetch, logger });
 *   await ops.publish('x', { accessToken }, { text });
 *
 * Invariants the whole package keeps:
 *   - never reads process.env, a database, or a file for credentials;
 *   - never drives a browser or a login form;
 *   - every platform refusal is a returned result, not a thrown error.
 */

const capabilities = require('./capabilities');
const connectors = require('./connectors');
const oauth = require('./oauth');
const adapt = require('./adapt');
const pipeline = require('./pipeline');
const edm = require('./edm');
const community = require('./community');
const matrix = require('./matrix/policy');
const { REFUSALS } = require('./refusals');
const { resolveDeps, fail } = require('./result');
const { version } = require('./package.json');

/** Machine-readable description of the layer, safe to serve to a UI or an agent. */
function manifest() {
  return {
    name: '@influencex/social-ops',
    version,
    holdsCredentials: false,
    publishModes: capabilities.PUBLISH_MODES,
    platforms: capabilities.listPlatforms().map((p) => ({
      id: p.id,
      label: p.label,
      region: p.region,
      publishMode: p.publishMode,
      auth: p.auth.kind,
      oauth: !!oauth.getProvider(p.id),
      credentialShape: p.credentialShape,
      text: p.text,
      media: p.media,
      metrics: p.metrics,
      limits: p.limits,
      requiresPlatformAudit: !!p.requiresPlatformAudit,
      auditNote: p.auditNote || null,
      endpointsVerified: !!p.endpointsVerified,
      docs: p.docs,
    })),
    capabilities: {
      publish: capabilities.PLATFORM_IDS,
      oauth: Object.keys(oauth.PROVIDERS),
      pipeline: ['plan', 'write', 'visual', 'adapt', 'gate', 'package'],
      edm: ['compliance', 'audience', 'suppression', 'warmup', 'breaker', 'campaign'],
      community: ['ledger', 'rules', 'disclosure', 'reddit', 'discord'],
      matrix: ['validateAccountProfile', 'planStagger'],
    },
    refusals: REFUSALS,
    hostResponsibilities: [
      'store credentials encrypted and pass them per call',
      'run OAuth consent in a browser session owned by the account holder',
      'persist post state, idempotency keys and metrics snapshots',
      'schedule (cron) and rate-limit per platform using limits from the matrix',
      'keep humans in the loop before irreversible publishes',
    ],
  };
}

/** Bind deps once and expose a small, host-friendly surface. */
function createSocialOps(depsIn = {}) {
  const deps = resolveDeps(depsIn);
  return {
    deps,
    manifest,
    capabilities,
    connectors,
    oauth: {
      ...oauth,
      exchangeCode: (provider, args) => oauth.exchangeCode(provider, args, deps),
      refreshAccessToken: (provider, args) => oauth.refreshAccessToken(provider, args, deps),
    },
    adapt,
    pipeline,
    edm,
    community,
    matrix,
    async publish(platform, credentials, payload) {
      const c = connectors.getConnector(platform);
      if (!c) return fail(`unknown platform: ${platform}`, { kind: 'client' });
      return c.publish(credentials, payload, deps);
    },
    validate(platform, payload) {
      const c = connectors.getConnector(platform);
      if (!c) return [`unknown platform: ${platform}`];
      return c.validate(payload);
    },
    async fetchMetrics(platform, credentials, externalId) {
      const c = connectors.getConnector(platform);
      if (!c) return { available: false, reason: `unknown platform: ${platform}` };
      return c.fetchMetrics(credentials, externalId, deps);
    },
  };
}

module.exports = {
  version,
  manifest,
  createSocialOps,
  capabilities,
  connectors,
  oauth,
  adapt,
  pipeline,
  edm,
  community,
  matrix,
  REFUSALS,
};
