'use strict';

/**
 * Platform adaptation — turn one piece of source content into a per-platform
 * variant that fits the platform's limits, and (for manual_package platforms)
 * into a paste-ready package.
 *
 * This is deterministic text shaping, not generation: the LLM work happens in
 * pipeline/ and produces the `content` this consumes. Keeping the two apart
 * means a host can run adaptation on hand-written copy, and tests can pin
 * every limit without an LLM.
 */

const { getPlatform, PUBLISH_MODES } = require('./capabilities');
const { extractHashtags } = require('./connectors/manual');

function normalizeTag(t) {
  return String(t || '').replace(/^#/, '').trim();
}

/** Split long text into ≤limit chunks on sentence boundaries, numbered "n/N". */
function splitThread(text, limit) {
  if (text.length <= limit) return [text];
  const budget = limit - 6; // room for the " n/N" suffix
  // Units: sentences, with any over-long sentence hard-wrapped at a word
  // boundary (or by characters for scripts without spaces) so nothing is lost.
  const units = [];
  for (const s of text.split(/(?<=[.!?。！？])\s*/)) {
    if (!s) continue;
    let rest = s;
    while (rest.length > budget) {
      let cut = rest.lastIndexOf(' ', budget);
      if (cut < budget * 0.5) cut = budget;
      units.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) units.push(rest);
  }
  const parts = [];
  let cur = '';
  for (const u of units) {
    if ((cur ? cur.length + 1 : 0) + u.length <= budget) cur = cur ? `${cur} ${u}` : u;
    else {
      if (cur) parts.push(cur);
      cur = u;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => (parts.length > 1 ? `${p} ${i + 1}/${parts.length}` : p));
}

function truncate(text, limit, warnings, label) {
  if (text.length <= limit) return text;
  warnings.push(`${label} exceeds ${limit} characters (${text.length}); truncated`);
  return text.slice(0, Math.max(0, limit - 1)) + '…';
}

/**
 * @param {string} platformId
 * @param {object} content  { title?, body, cta?, hashtags?, link?, imageUrls?, videoUrl?, coverUrl?, locale? }
 * @param {object} opts     { appendLink?: boolean (default true), hashtagStyle?: 'inline'|'trailing'|'none' }
 */
function adaptForPlatform(platformId, content = {}, opts = {}) {
  const p = getPlatform(platformId);
  if (!p) return { platform: platformId, error: `Unsupported platform: ${platformId}` };
  const warnings = [];
  const t = p.text;
  const hashtags = (content.hashtags || []).map(normalizeTag).filter(Boolean);
  const link = content.link || null;
  const appendLink = opts.appendLink !== false && !!link;

  let title = content.title ? String(content.title) : '';
  if (t.titleMaxLength != null && title) title = truncate(title, t.titleMaxLength, warnings, 'title');

  let body = String(content.body || '').trim();
  if (content.cta) body = body ? `${body}\n\n${content.cta}` : content.cta;

  // Hashtags: inline platforms get a trailing tag line; others keep tags as data.
  const tagLine = t.hashtagsInText && hashtags.length && opts.hashtagStyle !== 'none'
    ? hashtags.slice(0, t.maxHashtags || 30).map((h) => `#${h}`).join(' ')
    : '';
  if (t.maxHashtags && hashtags.length > t.maxHashtags) warnings.push(`${hashtags.length} hashtags > ${t.maxHashtags}; extra dropped`);

  const linkLine = appendLink ? link : '';
  const suffix = [tagLine, linkLine].filter(Boolean).join('\n');

  let text = suffix ? `${body}\n\n${suffix}` : body;
  let threadParts = null;

  if (t.supportsThread && p.id === 'x' && text.length > t.maxLength) {
    // Keep link + tags on the first post so the CTA is in the head of the thread.
    const head = suffix ? suffix.length + 2 : 0;
    const parts = splitThread(body, t.maxLength - head);
    text = suffix ? `${parts[0]}\n\n${suffix}` : parts[0];
    threadParts = parts.slice(1);
    warnings.push(`content exceeds ${t.maxLength}; split into ${parts.length}-post thread`);
  } else if (text.length > t.maxLength) {
    text = truncate(text, t.maxLength, warnings, 'text');
  }

  // Media requirements
  const imageUrls = content.imageUrls || (content.imageUrl ? [content.imageUrl] : []);
  const videoUrl = content.videoUrl || null;
  const usableImages = p.media.image === false ? [] : imageUrls;
  const usableVideo = p.media.video === false ? null : videoUrl;
  if (p.media.video === false && videoUrl) warnings.push(`${p.label} does not accept video; ignored`);
  if (p.media.image === false && imageUrls.length) warnings.push(`${p.label} is video-only; images ignored`);
  if (p.media.requiresMedia && !usableImages.length && !usableVideo) warnings.push(`${p.label} requires media; none provided`);
  if (p.media.coverRequired && !content.coverUrl) warnings.push(`${p.label} requires a cover image`);

  const variant = {
    platform: p.id,
    mode: p.publishMode,
    title: title || null,
    text,
    threadParts,
    hashtags: hashtags.slice(0, t.maxHashtags || undefined),
    link,
    imageUrls: p.media.image === false ? [] : imageUrls.slice(0, p.media.maxImages || imageUrls.length),
    videoUrl: p.media.video === false ? null : videoUrl,
    coverUrl: content.coverUrl || null,
    charCount: text.length,
    charLimit: t.maxLength,
    warnings,
  };

  if (p.publishMode === PUBLISH_MODES.MANUAL_PACKAGE) {
    variant.package = {
      title: variant.title,
      body: variant.text,
      hashtags: extractHashtags(variant.text).concat(variant.hashtags).filter((v, i, a) => a.indexOf(v) === i),
      images: variant.imageUrls,
      video: variant.videoUrl,
      cover: variant.coverUrl,
    };
  }
  if (p.id === 'wechat_mp') {
    // 公众号 body is HTML; plain text is wrapped paragraph-by-paragraph so an
    // operator can paste it, and the digest is derived from the first line.
    variant.digest = truncate(String(content.digest || body.split('\n')[0] || ''), t.digestMaxLength, warnings, 'digest');
    variant.html = content.html || body.split(/\n{2,}/).map((para) => `<p style="margin:0 0 1em;line-height:1.75">${para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('');
  }
  return variant;
}

/** Adapt one content piece for many platforms at once. */
function adaptForPlatforms(platformIds, content, opts) {
  return platformIds.map((id) => adaptForPlatform(id, content, opts));
}

module.exports = { adaptForPlatform, adaptForPlatforms, splitThread };
