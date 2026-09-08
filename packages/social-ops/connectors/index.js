'use strict';

/**
 * Connector registry. One entry per platform in the capability matrix; every
 * connector satisfies the same contract so a host can drive all twelve through
 * a single code path:
 *
 *   validate(payload)                          → string[]   (sync, no network)
 *   publish(credentials, payload, deps)        → { success, externalId, url, status, ... }
 *   fetchMetrics(credentials, externalId, deps)→ { available, metrics?, reason? }
 *
 * `status` after publish is one of:
 *   published       public now
 *   draft           in the platform's draft box / private; human presses publish
 *   scheduled       platform-side scheduler holds it
 *   pending_review  platform moderation before visibility
 *   packaged        manual_package: operator posts from the native app
 */

const { PLATFORM_IDS, resolvePlatformId } = require('../capabilities');

const CONNECTORS = Object.freeze({
  x: require('./x'),
  instagram: require('./instagram'),
  discord: require('./discord'),
  reddit: require('./reddit'),
  youtube: require('./youtube'),
  tiktok: require('./tiktok'),
  xiaohongshu: require('./manual').xiaohongshu,
  wechat_channels: require('./manual').wechatChannels,
  wechat_mp: require('./wechat-mp'),
  bilibili: require('./bilibili'),
  douyin: require('./douyin'),
  kuaishou: require('./kuaishou'),
});

const REQUIRED = ['platform', 'capabilities', 'validate', 'publish', 'fetchMetrics'];

/** Throws if a connector object does not satisfy the contract. */
function assertConnectorContract(c) {
  if (!c || typeof c !== 'object') throw new Error('connector must be an object');
  for (const k of REQUIRED) {
    if (!(k in c)) throw new Error(`connector ${c.platform || '?'} is missing ${k}`);
  }
  if (typeof c.validate !== 'function' || typeof c.publish !== 'function' || typeof c.fetchMetrics !== 'function') {
    throw new Error(`connector ${c.platform} has a non-function member`);
  }
  if (!PLATFORM_IDS.includes(c.platform)) throw new Error(`connector platform ${c.platform} is not in the capability matrix`);
  return true;
}

function getConnector(idOrAlias) {
  const id = resolvePlatformId(idOrAlias);
  return id ? CONNECTORS[id] : null;
}

function listConnectors() {
  return PLATFORM_IDS.map((id) => CONNECTORS[id]);
}

module.exports = { CONNECTORS, getConnector, listConnectors, assertConnectorContract };
