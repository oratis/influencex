/**
 * Outbound webhook notifications.
 *
 * Supports multiple sinks: Slack (incoming webhook), Feishu/Lark custom bot,
 * Discord webhook, and generic HTTP POST. Each sink is configured via env
 * vars; missing vars simply disable that sink (no error).
 *
 * Env vars:
 *   NOTIFY_SLACK_WEBHOOK_URL    - Slack incoming webhook URL
 *   NOTIFY_FEISHU_WEBHOOK_URL   - Feishu custom bot webhook URL
 *   NOTIFY_DISCORD_WEBHOOK_URL  - Discord webhook URL
 *   NOTIFY_GENERIC_WEBHOOK_URL  - Generic JSON POST target
 *
 * Events fire-and-forget — failures are logged, not thrown. We do NOT block
 * user requests on notification delivery.
 */

const fetch = require('./proxy-fetch');

function getEnabledSinks() {
  const sinks = [];
  if (process.env.NOTIFY_SLACK_WEBHOOK_URL) sinks.push('slack');
  if (process.env.NOTIFY_FEISHU_WEBHOOK_URL) sinks.push('feishu');
  if (process.env.NOTIFY_DISCORD_WEBHOOK_URL) sinks.push('discord');
  if (process.env.NOTIFY_GENERIC_WEBHOOK_URL) sinks.push('generic');
  return sinks;
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[notifications] ${url.slice(0, 40)}... returned ${res.status}`);
    }
  } catch (e) {
    console.warn(`[notifications] Failed to post to ${url.slice(0, 40)}...:`, e.message);
  }
}

async function sendSlack(event) {
  const url = process.env.NOTIFY_SLACK_WEBHOOK_URL;
  if (!url) return;
  await postJson(url, {
    text: `*${event.title}*\n${event.message}`,
    attachments: event.details ? [{
      color: event.level === 'error' ? 'danger' : event.level === 'success' ? 'good' : 'warning',
      fields: Object.entries(event.details).map(([k, v]) => ({ title: k, value: String(v), short: true })),
    }] : undefined,
  });
}

async function sendFeishu(event) {
  const url = process.env.NOTIFY_FEISHU_WEBHOOK_URL;
  if (!url) return;
  const detailsText = event.details
    ? '\n' + Object.entries(event.details).map(([k, v]) => `• ${k}: ${v}`).join('\n')
    : '';
  await postJson(url, {
    msg_type: 'text',
    content: { text: `【${event.title}】\n${event.message}${detailsText}` },
  });
}

async function sendDiscord(event) {
  const url = process.env.NOTIFY_DISCORD_WEBHOOK_URL;
  if (!url) return;
  const colorMap = { error: 0xff6b6b, success: 0x00d2a0, info: 0x74b9ff, warning: 0xfdcb6e };
  await postJson(url, {
    embeds: [{
      title: event.title,
      description: event.message,
      color: colorMap[event.level] || colorMap.info,
      fields: event.details
        ? Object.entries(event.details).map(([k, v]) => ({ name: k, value: String(v), inline: true }))
        : [],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function sendGeneric(event) {
  const url = process.env.NOTIFY_GENERIC_WEBHOOK_URL;
  if (!url) return;
  await postJson(url, {
    type: event.type,
    level: event.level || 'info',
    title: event.title,
    message: event.message,
    details: event.details || {},
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcast an event to all configured sinks.
 * Fire-and-forget; errors are logged but never thrown.
 *
 * @param {Object} event
 * @param {string} event.type      - Event identifier (e.g. "email.reply")
 * @param {string} event.title     - Short title
 * @param {string} event.message   - Body text
 * @param {string} [event.level]   - info | success | warning | error
 * @param {Object} [event.details] - Key/value pairs rendered as fields
 */
function notify(event) {
  // Return immediately; run sends in background
  Promise.all([
    sendSlack(event).catch(() => {}),
    sendFeishu(event).catch(() => {}),
    sendDiscord(event).catch(() => {}),
    sendGeneric(event).catch(() => {}),
  ]).catch(() => {});
}

/**
 * Convenience helpers for well-known events.
 */
const events = {
  emailReply: ({ kolName, subject, preview, threadUrl }) => notify({
    type: 'email.reply',
    level: 'success',
    title: 'New KOL reply received',
    message: `${kolName} replied to "${subject}"`,
    details: { preview: preview?.slice(0, 120), link: threadUrl },
  }),
  emailSent: ({ kolName, subject, to }) => notify({
    type: 'email.sent',
    level: 'info',
    title: 'Outreach sent',
    message: `Sent "${subject}" to ${kolName}`,
    details: { to },
  }),
  pipelineError: ({ kolName, stage, error }) => notify({
    type: 'pipeline.error',
    level: 'error',
    title: 'Pipeline error',
    message: `Failed at stage ${stage} for ${kolName}`,
    details: { error: error?.slice(0, 200) },
  }),
  discoveryComplete: ({ totalFound, keywords }) => notify({
    type: 'discovery.complete',
    level: 'success',
    title: 'KOL discovery complete',
    message: `Found ${totalFound} new creators`,
    details: { keywords: keywords?.slice(0, 120) },
  }),
  quotaWarning: ({ used, limit }) => notify({
    type: 'quota.warning',
    level: 'warning',
    title: 'YouTube API quota warning',
    message: `Used ${used}/${limit} units today (${Math.round(used / limit * 100)}%)`,
  }),
};

module.exports = { notify, events, getEnabledSinks };
