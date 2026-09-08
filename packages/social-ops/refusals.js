'use strict';

/**
 * Capabilities this layer deliberately does not provide, with the reason and
 * the legitimate substitute the layer DOES provide. Exposed through
 * `manifest()` so a host UI / agent planner can show them instead of
 * rediscovering the boundary at runtime.
 *
 * These are product boundaries, not missing features: each one is either a
 * ToS violation on every target platform, a legal exposure (FTC 16 CFR Part
 * 465 on fake indicators, 网信办《网络信息内容生态治理规定》第二十四条 on
 * 流量造假 / 水军, GDPR/CAN-SPAM on unsolicited mail), or both — and the
 * ban cascade from a detected bot network reaches the official accounts
 * that share an IP, device, payment method or recovery address.
 */
const REFUSALS = Object.freeze([
  Object.freeze({
    id: 'bot_account_farms',
    refused: 'Mass-creating social accounts (IP pools, device farms, generated identities) to post, comment or DM',
    why: 'Coordinated inauthentic behaviour: banned on X, Meta, Reddit, Discord, TikTok, YouTube, 小红书, 抖音, 快手, B 站; ban cascades reach the official accounts; illegal as 流量造假 / deceptive endorsement in CN/US/EU',
    instead: 'matrix/policy — a matrix of OWNED, DISCLOSED accounts (brand main / regional / topic, employee, creator partner), each connected by its human holder through the platform OAuth consent page',
  }),
  Object.freeze({
    id: 'mass_mailbox_registration',
    refused: 'Registering large numbers of consumer mailboxes (Gmail, Outlook, QQ, 163…) to send marketing mail',
    why: 'Provider ToS abuse; consumer domains cannot carry SPF/DKIM/DMARC for you; bulk mail from them is spam by definition and burns the sender reputation of everything else you run',
    instead: 'edm/ — consent-based lists, suppression, one-click unsubscribe, warm-up and complaint circuit-breaker on an OWNED sending domain via an ESP (Resend / SES / Cloudflare Email)',
  }),
  Object.freeze({
    id: 'cold_dm_automation',
    refused: 'Automated unsolicited DMs at scale',
    why: 'Spam under every platform policy; X/Instagram/Discord rate-ban senders within hours; the receiving side is the strongest prompt-injection surface an agent can be exposed to',
    instead: 'community agent — pull INBOUND mentions/DMs, classify, draft replies, human approves each send',
  }),
  Object.freeze({
    id: 'headless_browser_login',
    refused: 'Driving a browser with stored passwords to post on platforms without a public API',
    why: 'Requires plaintext credentials on a server, defeats 2FA, and is the #1 cause of official-account lockouts; no audit trail of what was posted',
    instead: 'manual_package mode — the layer produces a paste-ready, limit-checked package (title / body / tags / media / cover) for the operator to publish in the native app',
  }),
  Object.freeze({
    id: 'engagement_automation',
    refused: 'Auto-follow / auto-like / auto-comment loops to inflate reach',
    why: 'Platform manipulation policies; detection is trivial and the penalty lands on the account, not the tool',
    instead: 'Publish good content on a schedule, read the metrics back (fetchMetrics), and let the numbers pick the next piece',
  }),
]);

module.exports = { REFUSALS };
