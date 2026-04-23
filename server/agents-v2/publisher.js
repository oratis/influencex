/**
 * Publisher Agent — takes a content piece and adapts it for one or more
 * target platforms. Supports two dispatch modes in one interface:
 *
 *   mode: 'intent' (default)
 *     Produces a platform-optimized text + 1-click intent URL per platform.
 *     The user clicks the URL to open the native composer and post. No OAuth
 *     required. Respects user agency.
 *
 *   mode: 'direct'
 *     Posts through each platform's OAuth API using credentials stored in
 *     platform_connections. Requires ctx.workspaceId and ctx.db. Per-platform
 *     success is independent — returns an array of { platform, success,
 *     platform_post_id?, url?, error? }.
 *
 * The scheduled-publish processor always calls this agent regardless of mode,
 * so there's one dispatch path to wire into Conductor, RBAC, and metering.
 *
 * Supported platforms:
 *   - Intent mode: twitter, linkedin, facebook, pinterest, reddit, threads,
 *     bluesky, weibo
 *   - Direct mode: any provider registered in publish/oauth.js (twitter,
 *     linkedin, instagram, youtube, facebook, threads, tiktok, pinterest,
 *     reddit, medium, ghost, wordpress)
 */

const PLATFORM_LIMITS = {
  twitter: { charLimit: 280, threadSeparator: '\n---\n', supportsImage: true },
  linkedin: { charLimit: 3000, supportsImage: true },
  facebook: { charLimit: 63206, supportsImage: true },
  reddit: { charLimit: 40000, supportsImage: true, needsSubreddit: true },
  pinterest: { charLimit: 500, supportsImage: true, needsImage: true },
  threads: { charLimit: 500, supportsImage: true },
  bluesky: { charLimit: 300, supportsImage: true },
  weibo: { charLimit: 2000, supportsImage: true },
};

/**
 * Build a platform-specific intent URL. Each platform opens the user's
 * native composer pre-filled with the text (and url in some cases).
 */
function buildIntentUrl(platform, { text, url, hashtags = [] }) {
  const combinedText = hashtags.length
    ? `${text} ${hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ')}`
    : text;
  const encText = encodeURIComponent(combinedText);
  const encUrl = url ? encodeURIComponent(url) : '';

  switch (platform) {
    case 'twitter':
      return `https://twitter.com/intent/tweet?text=${encText}${url ? `&url=${encUrl}` : ''}`;
    case 'linkedin':
      return url
        ? `https://www.linkedin.com/sharing/share-offsite/?url=${encUrl}`
        : `https://www.linkedin.com/feed/?shareActive=true&text=${encText}`;
    case 'facebook':
      return url
        ? `https://www.facebook.com/sharer/sharer.php?u=${encUrl}&quote=${encText}`
        : `https://www.facebook.com/dialog/feed?app_id=0&link=${encodeURIComponent('https://influencexes.com')}&quote=${encText}`;
    case 'reddit':
      return `https://www.reddit.com/submit?title=${encodeURIComponent(text.slice(0, 300))}&selftext=${encText}`;
    case 'pinterest':
      return `https://www.pinterest.com/pin/create/button/?description=${encText}${url ? `&media=${encUrl}` : ''}`;
    case 'threads':
      return `https://www.threads.net/intent/post?text=${encText}`;
    case 'bluesky':
      return `https://bsky.app/intent/compose?text=${encText}`;
    case 'weibo':
      return `https://service.weibo.com/share/share.php?title=${encText}${url ? `&url=${encUrl}` : ''}`;
    default:
      return null;
  }
}

/**
 * Split a long text into tweets for X threads. Simple heuristic: break on
 * sentence boundaries, keep each tweet ≤ limit (accounting for " 1/N" suffix).
 */
function splitThread(text, limit = 275) {
  if (text.length <= limit) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const tweets = [];
  let current = '';
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length <= limit - 6) {
      current = (current + ' ' + s).trim();
    } else {
      if (current) tweets.push(current);
      current = s;
    }
  }
  if (current) tweets.push(current);
  // Add numbering
  return tweets.map((t, i) => tweets.length > 1 ? `${t} ${i + 1}/${tweets.length}` : t);
}

/**
 * Adapt content to a specific platform.
 * Returns { text, intent_url, image_url?, warnings: [] }.
 */
function adaptForPlatform(platform, content, opts = {}) {
  const limits = PLATFORM_LIMITS[platform];
  if (!limits) {
    return {
      platform,
      error: `Unsupported platform: ${platform}`,
    };
  }

  const warnings = [];
  const source = content.body || content.title || '';
  let text = source;

  // Append CTA if provided and there's room
  if (content.cta && text.length + content.cta.length + 2 <= limits.charLimit) {
    text = `${text}\n\n${content.cta}`.trim();
  }

  // Handle Twitter threads specifically
  let tweets = null;
  if (platform === 'twitter' && text.length > limits.charLimit) {
    tweets = splitThread(text, limits.charLimit - 5);
    // The intent URL posts just the first tweet; user can manually paste rest
    warnings.push(`Content exceeds 280 chars — split into ${tweets.length} tweets. Intent URL pre-fills the first tweet; the rest are shown for you to paste manually.`);
  } else if (text.length > limits.charLimit) {
    warnings.push(`Content exceeds ${platform} limit (${text.length} > ${limits.charLimit}). Truncating.`);
    text = text.slice(0, limits.charLimit - 3) + '...';
  }

  const hashtags = content.hashtags || [];
  const imageUrl = content.image_url || opts.image_url;

  if (limits.needsImage && !imageUrl) {
    warnings.push(`${platform} requires an image; no image_url provided.`);
  }

  const primaryText = tweets ? tweets[0] : text;
  const intentUrl = buildIntentUrl(platform, {
    text: primaryText,
    url: opts.share_url,
    hashtags: platform === 'reddit' ? [] : hashtags, // Reddit adds hashtags via subreddit convention
  });

  return {
    platform,
    text: primaryText,
    full_text: text,
    tweets,
    hashtags,
    image_url: imageUrl,
    char_count: primaryText.length,
    char_limit: limits.charLimit,
    intent_url: intentUrl,
    warnings,
  };
}

/**
 * Direct-mode dispatch. Looks up a platform_connections row per target
 * platform (workspace-scoped via ctx.workspaceId), then delegates to
 * publishOauth.publishDirect which knows the per-provider API shape.
 *
 * Each platform succeeds or fails independently. The run as a whole
 * returns successfully as long as the dispatch completed — callers read
 * per-platform success flags in `results[]`.
 */
async function runDirect(input, ctx) {
  if (!ctx?.db?.queryOne) {
    throw new Error('direct-mode publishing requires ctx.db.queryOne');
  }
  if (!ctx.workspaceId) {
    throw new Error('direct-mode publishing requires ctx.workspaceId (for credential scoping)');
  }
  // Required lazily so intent-mode callers don't pay the oauth module's
  // side-effects (proxy-fetch import, provider registry).
  const publishOauth = require('../publish/oauth');
  const { queryOne, exec } = ctx.db;

  ctx.emit('progress', {
    step: 'dispatching',
    message: `Direct-posting to ${input.platforms.length} platform(s)...`,
  });

  const content = input.content || {};
  const results = [];
  for (const platform of input.platforms) {
    ctx.emit('progress', { step: `posting ${platform}`, message: `Posting to ${platform}...` });

    const conn = await queryOne(
      'SELECT * FROM platform_connections WHERE workspace_id = ? AND platform = ?',
      [ctx.workspaceId, platform]
    );
    if (!conn) {
      results.push({ platform, success: false, error: `${platform} not connected for this workspace` });
      continue;
    }
    const provider = publishOauth.getProvider(platform);
    const credentials = provider?.kind === 'api_key'
      ? (() => { try { return JSON.parse(conn.metadata || '{}'); } catch { return {}; } })()
      : conn.access_token;

    try {
      const r = await publishOauth.publishDirect(platform, credentials, {
        text: content.body || content.title || '',
        title: content.title,
        imageUrl: content.image_url,
        video_url: content.video_url,
        link_url: content.link_url,
        subreddit: content.subreddit,
        board_id: content.board_id,
        tags: content.hashtags,
        accountId: conn.account_id,
      });
      results.push({ platform, ...r });
      if (exec) {
        await exec('UPDATE platform_connections SET last_used_at=CURRENT_TIMESTAMP WHERE id=?', [conn.id]).catch(() => {});
      }
    } catch (e) {
      results.push({ platform, success: false, error: e.message });
    }
  }

  const okCount = results.filter(r => r.success).length;
  ctx.emit('progress', {
    step: 'complete',
    message: `${okCount}/${results.length} platforms posted successfully`,
  });

  return {
    mode: 'direct',
    results,
    cost: { inputTokens: 0, outputTokens: 0, usdCents: 0 },
  };
}

module.exports = {
  id: 'publisher',
  name: 'Publisher',
  description: 'Adapt a content piece for one or more target platforms. Produces platform-optimized text + 1-click intent URLs so you can review + post in each native composer.',
  version: '1.0.0',
  capabilities: ['publish.twitter', 'publish.linkedin', 'publish.facebook', 'publish.reddit', 'publish.pinterest', 'publish.threads', 'publish.bluesky', 'publish.weibo'],

  inputSchema: {
    type: 'object',
    required: ['content', 'platforms'],
    properties: {
      content: {
        type: 'object',
        description: 'Source content. title + body. Optional cta, hashtags, image_url.',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          cta: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          image_url: { type: 'string' },
          video_url: { type: 'string' },
          link_url: { type: 'string' },
          subreddit: { type: 'string' },
          board_id: { type: 'string' },
        },
      },
      platforms: {
        type: 'array',
        description: 'Target platforms. In intent mode: from the PLATFORM_LIMITS list. In direct mode: any provider registered in publish/oauth.js.',
        items: { type: 'string' },
      },
      mode: {
        type: 'string',
        enum: ['intent', 'direct'],
        default: 'intent',
        description: 'intent = produce composer URLs (no OAuth); direct = post via platform APIs using stored credentials',
      },
      share_url: { type: 'string', description: 'Optional URL to attach (for link shares — intent mode only)' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            text: { type: 'string' },
            intent_url: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },

  costEstimate() {
    // No LLM calls; pure formatting. Tiny cost to cover DB writes.
    return { usdCents: 0, tokens: 0 };
  },

  async run(input, ctx) {
    if (!input?.content) throw new Error('content is required');
    if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
      throw new Error('platforms must be a non-empty array');
    }

    const mode = input.mode === 'direct' ? 'direct' : 'intent';

    if (mode === 'direct') {
      return runDirect(input, ctx);
    }

    ctx.emit('progress', { step: 'adapting', message: `Adapting for ${input.platforms.length} platform(s)...` });

    const results = input.platforms.map(p => {
      ctx.emit('progress', { step: `formatting ${p}`, message: `Preparing ${p} version...` });
      return adaptForPlatform(p, input.content, { share_url: input.share_url, image_url: input.content.image_url });
    });

    ctx.emit('progress', { step: 'complete', message: `${results.length} platform packages ready` });

    return {
      mode: 'intent',
      results,
      source_content: { title: input.content.title, word_count: (input.content.body || '').split(/\s+/).length },
      cost: { inputTokens: 0, outputTokens: 0, usdCents: 0 },
    };
  },

  // Exported for testing + other modules
  _internals: { adaptForPlatform, buildIntentUrl, splitThread, PLATFORM_LIMITS },
};
