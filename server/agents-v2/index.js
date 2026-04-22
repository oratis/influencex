/**
 * Register all v2 agents with the runtime.
 *
 * Called once at server boot from index.js.
 */

const runtime = require('../agent-runtime');

function registerAll() {
  const agents = [
    require('./strategy'),
    require('./research'),
    require('./content-text'),
    require('./content-visual'),
    require('./content-voice'),
    require('./content-video'),
    require('./publisher'),
    require('./kol-outreach'),
    require('./seo'),
    require('./competitor-monitor'),
    require('./review-miner'),
    require('./ads'),
    require('./discovery'),
  ];
  for (const a of agents) {
    try { runtime.registerAgent(a); }
    catch (e) { console.warn(`[agents-v2] Failed to register ${a.id}: ${e.message}`); }
  }
  return agents.map(a => a.id);
}

module.exports = { registerAll };
