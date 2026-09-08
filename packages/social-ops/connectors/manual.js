'use strict';

/**
 * manual_package connectors — 小红书 and 微信视频号 have no third-party
 * publishing API, so "publishing" here means producing a limit-checked,
 * paste-ready package the operator posts from the native app, and recording
 * that hand-off with a deterministic package id the host can reconcile with
 * the URL the operator pastes back.
 *
 * The connector never touches the platform: no login, no browser, no
 * credentials. That is a boundary (see refusals.js), not a gap.
 */

const crypto = require('crypto');
const { PLATFORMS } = require('../capabilities');
const { ok, fail } = require('../result');

function packageId(platform, payload) {
  const h = crypto.createHash('sha256').update(JSON.stringify({ platform, t: payload.title || '', b: payload.text || '', m: payload.mediaUrls || [], v: payload.videoUrl || '' })).digest('hex');
  return `${platform}:${h.slice(0, 16)}`;
}

function extractHashtags(text) {
  return (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1));
}

function makeManualConnector(platformId, buildPackage) {
  const caps = PLATFORMS[platformId];
  function validate(payload = {}) {
    const errors = [];
    const t = caps.text;
    if (!(payload.text || '').trim() && !(payload.mediaUrls || []).length && !payload.videoUrl) errors.push('text or media is required');
    if (t.titleMaxLength != null && (payload.title || '').length > t.titleMaxLength) errors.push(`title exceeds ${t.titleMaxLength} characters`);
    if ((payload.text || '').length > t.maxLength) errors.push(`text exceeds ${t.maxLength} characters`);
    if (caps.media.maxImages && (payload.mediaUrls || []).length > caps.media.maxImages) errors.push(`at most ${caps.media.maxImages} images`);
    if (t.maxHashtags && extractHashtags(payload.text).length > t.maxHashtags) errors.push(`more than ${t.maxHashtags} hashtags`);
    return errors;
  }
  async function publish(_credentials, payload = {}) {
    const errors = validate(payload);
    if (errors.length) return fail(errors.join('; '), { kind: 'client' });
    const id = packageId(platformId, payload);
    return ok({ externalId: id, url: null, status: 'packaged', requiresHumanFinalStep: true, package: buildPackage(payload, caps) });
  }
  async function fetchMetrics() {
    return { available: false, reason: `${caps.label} has no third-party read API; reconcile through tracked links` };
  }
  return { platform: platformId, capabilities: caps, validate, publish, fetchMetrics, packageId: (p) => packageId(platformId, p) };
}

const xiaohongshu = makeManualConnector('xiaohongshu', (payload, caps) => ({
  platform: 'xiaohongshu',
  title: (payload.title || '').slice(0, caps.text.titleMaxLength),
  body: payload.text || '',
  hashtags: extractHashtags(payload.text).concat(payload.tags || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, caps.text.maxHashtags),
  images: (payload.mediaUrls || []).slice(0, caps.media.maxImages),
  video: payload.videoUrl || null,
  cover: payload.coverUrl || null,
  steps: [
    '打开小红书 App → 发布 → 选择图片/视频（图片建议 3:4，≤18 张）',
    `标题粘贴（≤${caps.text.titleMaxLength} 字）`,
    `正文粘贴（≤${caps.text.maxLength} 字），话题用 # 在正文里点选`,
    '发布后把笔记链接贴回后台完成对账',
  ],
}));

const wechatChannels = makeManualConnector('wechat_channels', (payload, caps) => ({
  platform: 'wechat_channels',
  description: (payload.text || '').slice(0, caps.text.maxLength),
  hashtags: extractHashtags(payload.text).concat(payload.tags || []).filter((v, i, a) => a.indexOf(v) === i),
  video: payload.videoUrl || null,
  cover: payload.coverUrl || null,
  coverSpec: caps.media.recommendedCover,
  link: payload.link || null,
  steps: [
    '微信 → 视频号 → 发表视频 / 视频号助手（channels.weixin.qq.com）上传',
    '封面用 1080×1260，描述粘贴，话题用 # 点选；可挂公众号文章链接',
    '发表后把视频链接贴回后台完成对账',
  ],
}));

module.exports = { xiaohongshu, wechatChannels, makeManualConnector, extractHashtags };
