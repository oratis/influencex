/**
 * Publisher Agent — takes a content piece and adapts it for one or more
 * target platforms, producing a "publish package":
 *   - platform-optimized text (respects char limits + format conventions)
 *   - 1-click intent URL that opens the platform composer pre-filled
 *   - image URL (if applicable, pass-through)
 *   - suggested hashtags
 *
 * v1 is manual handoff — no OAuth, no scheduled posting. The user clicks
 * the intent URL, reviews the draft in the platform's native composer,
 * and posts. This is deliberate:
 *   - No platform API approval required
 *   - No token refresh / revocation headaches
 *   - Respects user agency (they always see the final before posting)
 *
 * v2 will add OAuth connectors for fully-automated posting. Same agent,
 * different mode.
 *
 * Supported platforms: twitter, linkedin, facebook, pinterest, reddit,
 * threads, bluesky, weibo (Chinese). Others via generic URL share.
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
        },
      },
      platforms: {
        type: 'array',
        description: 'Target platforms (e.g. ["twitter", "linkedin"])',
        items: { type: 'string', enum: Object.keys(PLATFORM_LIMITS) },
      },
      share_url: { type: 'string', description: 'Optional URL to attach (for link shares)' },
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

    ctx.emit('progress', { step: 'adapting', message: `Adapting for ${input.platforms.length} platform(s)...` });

    const results = input.platforms.map(p => {
      ctx.emit('progress', { step: `formatting ${p}`, message: `Preparing ${p} version...` });
      return adaptForPlatform(p, input.content, { share_url: input.share_url, image_url: input.content.image_url });
    });

    ctx.emit('progress', { step: 'complete', message: `${results.length} platform packages ready` });

    return {
      results,
      source_content: { title: input.content.title, word_count: (input.content.body || '').split(/\s+/).length },
      cost: { inputTokens: 0, outputTokens: 0, usdCents: 0 },
    };
  },

  // Exported for testing + other modules
  _internals: { adaptForPlatform, buildIntentUrl, splitThread, PLATFORM_LIMITS },
};
