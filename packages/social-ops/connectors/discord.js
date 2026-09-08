'use strict';

/**
 * Discord connector — channel messages via bot token, or webhook fallback.
 *
 * credentials: { botToken, channelId } | { webhookUrl }
 * payload:     { text, title?, embed?: { title, description, url, imageUrl, color }, attachmentUrls?, threadName? }
 *
 * Bot mode honours the channel's slowmode (`rate_limit_per_user`) by reporting
 * it back, and can read reactions for fetchMetrics. Webhook mode can post but
 * never read. Both are official surfaces — no user-token automation.
 */

const { PLATFORMS } = require('../capabilities');
const { ok, fail, httpFailure, readJson, resolveDeps, fetchBinary } = require('../result');

const API = 'https://discord.com/api/v10';

function validate(payload = {}) {
  const errors = [];
  const text = payload.text || '';
  if (!text.trim() && !payload.embed && !(payload.attachmentUrls && payload.attachmentUrls.length)) errors.push('text, embed or attachments required');
  if (text.length > PLATFORMS.discord.text.maxLength) errors.push(`text exceeds ${PLATFORMS.discord.text.maxLength} characters`);
  if (payload.embed && (payload.embed.description || '').length > PLATFORMS.discord.text.embedDescriptionMax) errors.push(`embed description exceeds ${PLATFORMS.discord.text.embedDescriptionMax} characters`);
  if ((payload.attachmentUrls || []).length > PLATFORMS.discord.media.maxAttachments) errors.push(`at most ${PLATFORMS.discord.media.maxAttachments} attachments`);
  return errors;
}

function buildEmbeds(payload) {
  if (!payload.embed) return undefined;
  const e = payload.embed;
  const embed = {};
  if (e.title) embed.title = String(e.title).slice(0, PLATFORMS.discord.text.titleMaxLength);
  if (e.description) embed.description = String(e.description).slice(0, PLATFORMS.discord.text.embedDescriptionMax);
  if (e.url) embed.url = e.url;
  if (e.imageUrl) embed.image = { url: e.imageUrl };
  if (e.thumbnailUrl) embed.thumbnail = { url: e.thumbnailUrl };
  if (e.color != null) embed.color = e.color;
  return [embed];
}

async function buildBody(payload, deps) {
  const json = { content: payload.text || '', embeds: buildEmbeds(payload), allowed_mentions: { parse: [] } };
  if (payload.threadName) json.thread_name = payload.threadName;
  const urls = payload.attachmentUrls || [];
  if (!urls.length) return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) };
  const form = new FormData();
  json.attachments = [];
  for (let i = 0; i < urls.length; i++) {
    const bin = await fetchBinary(urls[i], deps);
    if (bin.error) return { error: bin.error };
    if (bin.buffer.length > PLATFORMS.discord.media.maxAttachmentBytes) return { error: `attachment ${i} exceeds ${PLATFORMS.discord.media.maxAttachmentBytes} bytes` };
    const name = `file${i}.${(bin.contentType.split('/')[1] || 'bin').split(';')[0]}`;
    json.attachments.push({ id: i, filename: name });
    form.set(`files[${i}]`, new Blob([bin.buffer], { type: bin.contentType }), name);
  }
  form.set('payload_json', JSON.stringify(json));
  return { headers: {}, body: form };
}

async function publish(credentials, payload = {}, depsIn) {
  const deps = resolveDeps(depsIn);
  const errors = validate(payload);
  if (errors.length) return fail(errors.join('; '), { kind: 'client' });
  const creds = credentials || {};

  const built = await buildBody(payload, deps);
  if (built.error) return fail(built.error, { kind: 'client' });

  if (creds.botToken && creds.channelId) {
    const res = await deps.fetch(`${API}/channels/${encodeURIComponent(creds.channelId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${creds.botToken}`, ...built.headers },
      body: built.body,
    });
    if (!res.ok) return httpFailure('Discord API', res);
    const m = await readJson(res);
    const guild = creds.guildId || (m && m.guild_id) || '@me';
    return ok({ externalId: m && m.id ? m.id : null, url: m && m.id ? `https://discord.com/channels/${guild}/${creds.channelId}/${m.id}` : null, status: 'published', mode: 'bot' });
  }
  if (creds.webhookUrl) {
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(creds.webhookUrl)) return fail('webhookUrl must be a discord.com webhook', { kind: 'auth' });
    const url = `${creds.webhookUrl}${creds.webhookUrl.includes('?') ? '&' : '?'}wait=true`;
    const res = await deps.fetch(url, { method: 'POST', headers: built.headers, body: built.body });
    if (!res.ok) return httpFailure('Discord webhook', res);
    const m = await readJson(res);
    return ok({ externalId: m && m.id ? m.id : null, url: null, status: 'published', mode: 'webhook' });
  }
  return fail('discord: provide { botToken, channelId } or { webhookUrl }', { kind: 'auth' });
}

/** Channel info — used by community/discord to honour slowmode. */
async function getChannel(credentials, channelId, depsIn) {
  const deps = resolveDeps(depsIn);
  if (!credentials || !credentials.botToken) return fail('discord: botToken is required', { kind: 'auth' });
  const res = await deps.fetch(`${API}/channels/${encodeURIComponent(channelId)}`, { headers: { Authorization: `Bot ${credentials.botToken}` } });
  if (!res.ok) return httpFailure('Discord channel', res);
  const c = await readJson(res);
  return ok({ id: c.id, name: c.name, rateLimitPerUser: c.rate_limit_per_user || 0, nsfw: !!c.nsfw, raw: c });
}

async function fetchMetrics(credentials, externalId, depsIn) {
  const deps = resolveDeps(depsIn);
  const creds = credentials || {};
  if (!creds.botToken || !creds.channelId) return { available: false, reason: 'metrics need a bot token + channel (webhooks cannot read)' };
  if (!externalId) return { available: false, reason: 'externalId is required' };
  const res = await deps.fetch(`${API}/channels/${encodeURIComponent(creds.channelId)}/messages/${encodeURIComponent(externalId)}`, { headers: { Authorization: `Bot ${creds.botToken}` } });
  if (!res.ok) return { available: false, reason: (await httpFailure('Discord message', res)).error, status: res.status };
  const m = await readJson(res);
  const reactions = (m && m.reactions) || [];
  const likes = reactions.reduce((n, r) => n + (r.count || 0), 0);
  const replies = m && m.thread && m.thread.message_count != null ? m.thread.message_count : null;
  return { available: true, metrics: { impressions: null, views: null, likes, comments: replies, shares: null, saves: null, raw: m } };
}

module.exports = { platform: 'discord', capabilities: PLATFORMS.discord, validate, publish, getChannel, fetchMetrics };
