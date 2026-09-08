'use strict';

/**
 * Community capability — posting and engaging in community products
 * (Reddit, Discord, forums) as a disclosed official account, under the
 * playbook rules. Composes the connectors with the ledger + rules checks so
 * a host has one call that either posts or explains why not.
 */

const playbook = require('./playbook');
const reddit = require('../connectors/reddit');
const discord = require('../connectors/discord');
const { resolveDeps, fail, ok } = require('../result');

const UNSUPPORTED = Object.freeze(['dm.cold_outbound', 'accounts.bulk_create', 'engagement.auto_like', 'engagement.auto_follow', 'votes.manipulate']);

/**
 * Post a PROMOTIONAL piece to a subreddit, but only after: contribution ratio
 * ≥ 7:1, cooldown elapsed, subreddit rules do not forbid it, disclosure added.
 */
async function promoteOnReddit(credentials, { subreddit, title, text, link, flairId, ledger, brand, role, locale, playbookOpts }, depsIn) {
  const deps = resolveDeps(depsIn);
  if (!ledger) return fail('a contribution ledger is required for promotional posts', { kind: 'client' });
  const rules = await reddit.fetchSubredditRules(credentials, subreddit, deps);
  const assessment = rules.success ? playbook.assessCommunityRules(rules.rules) : { selfPromotionRestricted: false, matchedRules: [], rulesUnavailable: rules.error };
  const decision = playbook.canPromote(ledger, subreddit, { ...(playbookOpts || {}), rulesAssessment: assessment });
  if (!decision.allowed) return fail(decision.reason, { kind: 'policy', decision, assessment });
  const body = link ? text : playbook.buildDisclosedPost(text, { brand, role, locale });
  const r = await reddit.publish(credentials, { subreddit, title, text: link ? undefined : body, link, flairId }, deps);
  if (r.success) ledger.record(subreddit, 'promotion', deps.now().toISOString());
  return { ...r, decision, assessment };
}

/** A genuine contribution (answer, resource, discussion) — recorded as such. */
async function contributeOnReddit(credentials, { subreddit, title, text, parentFullname, ledger }, depsIn) {
  const deps = resolveDeps(depsIn);
  const r = parentFullname
    ? await reddit.comment(credentials, { parentFullname, text }, deps)
    : await reddit.publish(credentials, { subreddit, title, text }, deps);
  if (r.success && ledger) ledger.record(subreddit, 'contribution', deps.now().toISOString());
  return r;
}

/** Post to a Discord channel honouring slowmode (bot mode) — returns the wait if throttled. */
async function postToDiscordChannel(credentials, payload, { lastPostAt } = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  if (credentials && credentials.botToken && credentials.channelId) {
    const ch = await discord.getChannel(credentials, credentials.channelId, deps);
    if (ch.success && ch.rateLimitPerUser && lastPostAt) {
      const waitMs = ch.rateLimitPerUser * 1000 - (deps.now().getTime() - new Date(lastPostAt).getTime());
      if (waitMs > 0) return fail(`slowmode: wait ${Math.ceil(waitMs / 1000)}s`, { kind: 'rate_limit', retryable: true, retryAfterMs: waitMs });
    }
  }
  return discord.publish(credentials, payload, deps);
}

module.exports = { ...playbook, UNSUPPORTED, promoteOnReddit, contributeOnReddit, postToDiscordChannel, ok };
