'use strict';

/**
 * The platform capability matrix — the single place that answers "what can we
 * do on platform P, through which door, under which limits".
 *
 * Every number here is PUBLIC information as of 2026-09 and platforms change
 * these often. `endpointsVerified` records whether the connector's request
 * shapes were exercised against the live API by this repo's maintainers;
 * `false` means "implemented from published docs, verify before issuing
 * credentials". `requiresPlatformAudit` means the platform reviews the app
 * before the write scope works at all (TikTok video.publish, 抖音/快手/B 站
 * 开放平台 投稿能力).
 *
 * publishMode:
 *   api_direct     — the connector can create the public post itself
 *   api_draft      — the connector can only land content in a draft box /
 *                    private state; a human presses publish in the native app
 *   manual_package — no third-party write API exists; the layer produces a
 *                    limit-checked paste package for the operator
 */

const PUBLISH_MODES = Object.freeze({
  API_DIRECT: 'api_direct',
  API_DRAFT: 'api_draft',
  MANUAL_PACKAGE: 'manual_package',
});

const PLATFORMS = Object.freeze({
  x: {
    id: 'x',
    label: 'X',
    aliases: ['twitter'],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2_pkce', scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'] },
    text: { maxLength: 280, titleMaxLength: null, supportsThread: true, hashtagsInText: true },
    media: { image: true, video: true, maxImages: 4, maxVideoSeconds: 140, videoUploadMode: 'chunked' },
    metrics: { readsOwn: 'paid_tier', note: 'Free tier is write-only; public_metrics needs Basic+' },
    limits: { perDay: 50, perHour: 10, note: 'Free tier ≈ 1,500 posts/month app-wide; keep daily cap well under' },
    requiresPlatformAudit: false,
    endpointsVerified: true,
    docs: 'https://docs.x.com/x-api/posts/creation-of-a-post',
    credentialShape: ['accessToken'],
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram (Business/Creator)',
    aliases: ['ig'],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2', scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'instagram_manage_insights'] },
    text: { maxLength: 2200, titleMaxLength: null, supportsThread: false, hashtagsInText: true, maxHashtags: 30 },
    media: { image: true, video: true, requiresMedia: true, maxImages: 10, maxVideoSeconds: 900, videoKind: 'reels' },
    metrics: { readsOwn: 'yes', note: 'Insights API on published media' },
    limits: { perDay: 25, perHour: 10, note: 'Content Publishing API: 25 API-published posts per 24h' },
    requiresPlatformAudit: false,
    endpointsVerified: true,
    docs: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    credentialShape: ['accessToken', 'igUserId'],
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    aliases: [],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'bot_token_or_webhook', scopes: ['bot'] },
    text: { maxLength: 2000, titleMaxLength: 256, supportsThread: true, hashtagsInText: false, embedDescriptionMax: 4096 },
    media: { image: true, video: true, maxAttachments: 10, maxAttachmentBytes: 10 * 1024 * 1024 },
    metrics: { readsOwn: 'bot_only', note: 'Reactions / reply counts via bot; webhooks cannot read' },
    limits: { perDay: 200, perHour: 30, note: 'Global 50 req/s; per-channel slowmode must be honoured' },
    requiresPlatformAudit: false,
    endpointsVerified: true,
    docs: 'https://discord.com/developers/docs/resources/message#create-message',
    credentialShape: ['botToken', 'channelId', 'webhookUrl'],
  },
  reddit: {
    id: 'reddit',
    label: 'Reddit',
    aliases: [],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2', scopes: ['identity', 'submit', 'read', 'flair'] },
    text: { maxLength: 40000, titleMaxLength: 300, supportsThread: false, hashtagsInText: false },
    media: { image: true, video: true, linkPosts: true },
    metrics: { readsOwn: 'yes', note: 'score / num_comments / upvote_ratio via /api/info' },
    limits: { perDay: 3, perHour: 1, note: 'Community-governed; contribution ratio and subreddit rules apply (community/playbook)' },
    requiresPlatformAudit: false,
    endpointsVerified: true,
    docs: 'https://www.reddit.com/dev/api/#POST_api_submit',
    credentialShape: ['accessToken'],
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    aliases: ['yt'],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2_pkce', scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'] },
    text: { maxLength: 5000, titleMaxLength: 100, supportsThread: false, hashtagsInText: true, tagsTotalMaxLength: 500 },
    media: { image: false, video: true, requiresMedia: true, shortsMaxSeconds: 180 },
    metrics: { readsOwn: 'yes', note: 'videos.list statistics (1 quota unit)' },
    limits: { perDay: 6, perHour: 2, quotaUnitsPerDay: 10000, quotaUnitsPerUpload: 1600, note: 'Default 10,000 units/day; videos.insert ≈ 1,600 units' },
    requiresPlatformAudit: false,
    endpointsVerified: true,
    docs: 'https://developers.google.com/youtube/v3/docs/videos/insert',
    credentialShape: ['accessToken'],
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    aliases: [],
    region: 'global',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2_pkce', scopes: ['user.info.basic', 'video.upload', 'video.publish', 'video.list'] },
    text: { maxLength: 2200, titleMaxLength: null, supportsThread: false, hashtagsInText: true },
    media: { image: true, video: true, requiresMedia: true, maxVideoSeconds: 600, photoPosts: true },
    metrics: { readsOwn: 'scoped', note: 'video.list scope → /v2/video/query' },
    limits: { perDay: 15, perHour: 5, note: 'Content Posting API: 15 posts/24h per user' },
    requiresPlatformAudit: true,
    auditNote: 'Unaudited apps can only post privacy_level=SELF_ONLY (draft in the app); audit unlocks public posting',
    endpointsVerified: true,
    docs: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post',
    credentialShape: ['accessToken'],
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    label: '小红书',
    aliases: ['xhs', 'rednote'],
    region: 'cn',
    publishMode: PUBLISH_MODES.MANUAL_PACKAGE,
    auth: { kind: 'none', scopes: [] },
    text: { maxLength: 1000, titleMaxLength: 20, supportsThread: false, hashtagsInText: true, maxHashtags: 10 },
    media: { image: true, video: true, maxImages: 18, maxVideoSeconds: 900, recommendedImageRatio: '3:4' },
    metrics: { readsOwn: 'no', note: 'No third-party read API; use tracked links' },
    limits: { perDay: 3, perHour: 1 },
    requiresPlatformAudit: false,
    endpointsVerified: false,
    docs: 'https://creator.xiaohongshu.com/',
    notes: ['No public posting API for third-party apps; 蒲公英 / 聚光 are ads-side products, not publishing APIs', 'Limits above are the creator-app limits at time of writing'],
    credentialShape: [],
  },
  wechat_channels: {
    id: 'wechat_channels',
    label: '微信视频号',
    aliases: ['channels', 'shipinhao'],
    region: 'cn',
    publishMode: PUBLISH_MODES.MANUAL_PACKAGE,
    auth: { kind: 'none', scopes: [] },
    text: { maxLength: 1000, titleMaxLength: null, supportsThread: false, hashtagsInText: true },
    media: { image: true, video: true, maxVideoSeconds: 3600, recommendedCover: '1080x1260' },
    metrics: { readsOwn: 'no', note: 'No third-party read API' },
    limits: { perDay: 3, perHour: 1 },
    requiresPlatformAudit: false,
    endpointsVerified: false,
    docs: 'https://channels.weixin.qq.com/',
    notes: ['No third-party publishing API (视频号助手 is a web console, not an API)'],
    credentialShape: [],
  },
  wechat_mp: {
    id: 'wechat_mp',
    label: '微信公众号',
    aliases: ['wechat', 'weixin', 'mp'],
    region: 'cn',
    publishMode: PUBLISH_MODES.API_DRAFT,
    auth: { kind: 'app_credential', scopes: ['draft', 'freepublish', 'material'], ipAllowlist: true },
    text: { maxLength: 20000, titleMaxLength: 64, digestMaxLength: 120, authorMaxLength: 8, supportsThread: false, hashtagsInText: false, bodyFormat: 'inline_html' },
    media: { image: true, video: false, coverRatio: '2.35:1', coverRecommended: '2960x1260', bodyImagesMustBeUploaded: true },
    metrics: { readsOwn: 'yes', note: 'datacube/getarticletotal after publish' },
    limits: { perDay: 1, perHour: 1, note: '订阅号 1 次群发/天，服务号 4 次/月；草稿不限' },
    requiresPlatformAudit: false,
    auditNote: 'freepublish requires a 认证 account; unverified accounts can only draft',
    endpointsVerified: true,
    docs: 'https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html',
    notes: ['AppSecret is a server credential: callers must be on the API IP allowlist', 'Draft-first by design: freepublish/submit is the irreversible step and is a separate call'],
    credentialShape: ['appId', 'appSecret'],
  },
  bilibili: {
    id: 'bilibili',
    label: '哔哩哔哩',
    aliases: ['bili', 'b站'],
    region: 'cn',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2_signed', scopes: ['ARC_BASE', 'USER_INFO'] },
    text: { maxLength: 2000, titleMaxLength: 80, supportsThread: false, hashtagsInText: false, maxTags: 10, tagMaxLength: 20 },
    media: { image: false, video: true, requiresMedia: true, coverRequired: true, recommendedCover: '1280x720' },
    metrics: { readsOwn: 'scoped', note: 'archive view data via 开放平台 数据接口 (scope-gated)' },
    limits: { perDay: 3, perHour: 1 },
    requiresPlatformAudit: true,
    auditNote: '开放平台 视频稿件投稿 requires an approved application; requests are HMAC-signed with the app secret',
    endpointsVerified: false,
    docs: 'https://openhome.bilibili.com/doc/4/',
    credentialShape: ['accessToken', 'clientId', 'clientSecret'],
  },
  douyin: {
    id: 'douyin',
    label: '抖音',
    aliases: ['dy'],
    region: 'cn',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2', scopes: ['video.create', 'video.data', 'user_info'] },
    text: { maxLength: 1000, titleMaxLength: null, supportsThread: false, hashtagsInText: true, hashtagSyntax: '#tag ' },
    media: { image: true, video: true, requiresMedia: true, maxVideoSeconds: 900, imagePosts: true },
    metrics: { readsOwn: 'scoped', note: 'video.data scope → /api/douyin/v1/video/video_data/' },
    limits: { perDay: 5, perHour: 2 },
    requiresPlatformAudit: true,
    auditNote: 'video.create is granted per app after 抖音开放平台 review; 企业号 required for most brands',
    endpointsVerified: false,
    docs: 'https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/create-video',
    credentialShape: ['accessToken', 'openId'],
  },
  kuaishou: {
    id: 'kuaishou',
    label: '快手',
    aliases: ['ks'],
    region: 'cn',
    publishMode: PUBLISH_MODES.API_DIRECT,
    auth: { kind: 'oauth2', scopes: ['user_info', 'user_video_publish', 'user_video_info'] },
    text: { maxLength: 1000, titleMaxLength: null, supportsThread: false, hashtagsInText: true, hashtagSyntax: '#tag ' },
    media: { image: false, video: true, requiresMedia: true, maxVideoSeconds: 900 },
    metrics: { readsOwn: 'scoped', note: 'user_video_info scope → /openapi/photo/list' },
    limits: { perDay: 5, perHour: 2 },
    requiresPlatformAudit: true,
    auditNote: 'user_video_publish is granted per app after 快手开放平台 review',
    endpointsVerified: false,
    docs: 'https://open.kuaishou.com/platform/openApi?menu=17',
    credentialShape: ['accessToken', 'appId'],
  },
});

const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

const ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const p of Object.values(PLATFORMS)) {
    idx.set(p.id, p.id);
    for (const a of p.aliases || []) idx.set(a, p.id);
  }
  return idx;
})();

/** Resolve an id or alias ("twitter" → "x") to the canonical platform id, or null. */
function resolvePlatformId(idOrAlias) {
  if (!idOrAlias) return null;
  return ALIAS_INDEX.get(String(idOrAlias).toLowerCase()) || null;
}

function getPlatform(idOrAlias) {
  const id = resolvePlatformId(idOrAlias);
  return id ? PLATFORMS[id] : null;
}

function listPlatforms() {
  return PLATFORM_IDS.map((id) => PLATFORMS[id]);
}

function platformsByMode(mode) {
  return listPlatforms().filter((p) => p.publishMode === mode);
}

/** True when the connector can create or stage a post through an API. */
function hasWriteApi(idOrAlias) {
  const p = getPlatform(idOrAlias);
  return !!p && p.publishMode !== PUBLISH_MODES.MANUAL_PACKAGE;
}

module.exports = {
  PUBLISH_MODES,
  PLATFORMS,
  PLATFORM_IDS,
  resolvePlatformId,
  getPlatform,
  listPlatforms,
  platformsByMode,
  hasWriteApi,
};
