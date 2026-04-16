/**
 * Real KOL profile scraper
 * Uses official APIs where available:
 * - YouTube Data API v3 (free, 10K units/day)
 * - TikTok: unofficial oembed + page meta (no API key needed for basic data)
 * - For full TikTok/Instagram data at scale: requires Modash API or similar
 *
 * Required env vars:
 * - YOUTUBE_API_KEY: Google API key with YouTube Data API v3 enabled
 * - MODASH_API_KEY: (optional) For TikTok/Instagram full data
 */

const fetch = require('./proxy-fetch');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const MODASH_API_KEY = process.env.MODASH_API_KEY;

// ==================== YouTube Data API v3 ====================

async function scrapeYouTube(profileUrl, username) {
  if (!YOUTUBE_API_KEY) {
    return { success: false, error: 'YOUTUBE_API_KEY not configured. Get one at console.cloud.google.com (enable YouTube Data API v3).' };
  }

  try {
    // Step 1: Resolve @handle or channel URL to channel ID
    let channelId = null;

    if (profileUrl.includes('/channel/')) {
      channelId = profileUrl.match(/\/channel\/([^/?&]+)/)?.[1];
    } else if (profileUrl.includes('/@')) {
      // Use search to resolve @handle → channel ID (costs 100 quota units)
      const handle = profileUrl.match(/@([^/?&]+)/)?.[1];
      if (handle) {
        // Try forHandle first (cheaper, 1 unit)
        const handleRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${YOUTUBE_API_KEY}`
        );
        const handleData = await handleRes.json();
        if (handleData.items?.length > 0) {
          channelId = handleData.items[0].id;
        } else {
          // Fallback to search (100 units)
          const searchRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=id&q=${handle}&type=channel&maxResults=1&key=${YOUTUBE_API_KEY}`
          );
          const searchData = await searchRes.json();
          channelId = searchData.items?.[0]?.id?.channelId;
        }
      }
    } else if (profileUrl.includes('/c/')) {
      // Custom URL format - need search
      const customName = profileUrl.match(/\/c\/([^/?&]+)/)?.[1];
      if (customName) {
        const searchRes = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=id&q=${customName}&type=channel&maxResults=1&key=${YOUTUBE_API_KEY}`
        );
        const searchData = await searchRes.json();
        channelId = searchData.items?.[0]?.id?.channelId;
      }
    }

    if (!channelId) {
      return { success: false, error: 'Could not resolve YouTube channel ID from URL' };
    }

    // Step 2: Get channel details (1-3 quota units)
    const channelRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&id=${channelId}&key=${YOUTUBE_API_KEY}`
    );
    const channelData = await channelRes.json();

    if (!channelData.items || channelData.items.length === 0) {
      return { success: false, error: 'Channel not found' };
    }

    const ch = channelData.items[0];
    const stats = ch.statistics;
    const snippet = ch.snippet;

    const subscribers = parseInt(stats.subscriberCount) || 0;
    const totalViews = parseInt(stats.viewCount) || 0;
    const videoCount = parseInt(stats.videoCount) || 0;

    // Calculate approximate avg views per video
    const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;

    // Get recent videos for engagement rate calculation (5 quota units)
    let engagementRate = 0;
    let recentAvgViews = avgViews;
    try {
      const videosRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&type=video&order=date&maxResults=10&key=${YOUTUBE_API_KEY}`
      );
      const videosData = await videosRes.json();
      const videoIds = (videosData.items || []).map(v => v.id.videoId).filter(Boolean);

      if (videoIds.length > 0) {
        const statsRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
        );
        const statsData = await statsRes.json();
        const videos = statsData.items || [];

        let totalLikes = 0, totalComments = 0, totalVideoViews = 0;
        for (const v of videos) {
          totalVideoViews += parseInt(v.statistics.viewCount) || 0;
          totalLikes += parseInt(v.statistics.likeCount) || 0;
          totalComments += parseInt(v.statistics.commentCount) || 0;
        }

        if (videos.length > 0) {
          recentAvgViews = Math.round(totalVideoViews / videos.length);
          if (totalVideoViews > 0) {
            engagementRate = +((totalLikes + totalComments) / totalVideoViews * 100).toFixed(2);
          }
        }
      }
    } catch (e) {
      console.warn('YouTube engagement calc error:', e.message);
    }

    // Detect category from description/title
    const category = detectCategory(snippet.description + ' ' + snippet.title);

    // Enhanced email discovery: try bio text, then follow links in description
    const email = await discoverEmail(snippet.description || '', '');

    return {
      success: true,
      data: {
        display_name: snippet.title,
        avatar_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
        bio: (snippet.description || '').slice(0, 500),
        followers: subscribers,
        following: 0,
        engagement_rate: engagementRate,
        avg_views: recentAvgViews,
        total_videos: videoCount,
        category,
        country: snippet.country || '',
        language: snippet.defaultLanguage || '',
        email,
      },
    };
  } catch (e) {
    return { success: false, error: `YouTube API error: ${e.message}` };
  }
}

// ==================== TikTok (lightweight, no API key) ====================

async function scrapeTikTok(profileUrl, username) {
  // TikTok has no free official API for profile data.
  // Strategy:
  // 1. Try fetching the profile page and extracting meta tags (og:image, description, etc.)
  // 2. If MODASH_API_KEY is set, use Modash for full data

  if (MODASH_API_KEY) {
    return scrapeViaModash(username, 'tiktok');
  }

  try {
    // Fetch TikTok profile page - extract Open Graph meta tags
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(profileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const html = await res.text();

    // Extract from meta tags and JSON-LD
    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1];
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1];
    const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/)?.[1] || '';

    // Try to extract follower/like counts from description (TikTok often includes "X Followers, Y Likes")
    const followerMatch = ogDesc.match(/([\d.]+[KMB]?)\s*Followers/i);
    const likesMatch = ogDesc.match(/([\d.]+[KMB]?)\s*Likes/i);

    const followers = followerMatch ? parseAbbreviatedNumber(followerMatch[1]) : 0;
    const totalLikes = likesMatch ? parseAbbreviatedNumber(likesMatch[1]) : 0;

    // Try to parse the SIGI_STATE or __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON
    let userData = null;
    const sigiMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (sigiMatch) {
      try {
        const json = JSON.parse(sigiMatch[1]);
        const defaultScope = json.__DEFAULT_SCOPE__ || {};
        const userDetail = defaultScope['webapp.user-detail']?.userInfo;
        if (userDetail) {
          userData = {
            display_name: userDetail.user?.nickname,
            avatar_url: userDetail.user?.avatarLarger || userDetail.user?.avatarMedium || userDetail.user?.avatarThumb,
            bio: userDetail.user?.signature || '',
            followers: userDetail.stats?.followerCount || followers,
            following: userDetail.stats?.followingCount || 0,
            total_likes: userDetail.stats?.heartCount || totalLikes,
            total_videos: userDetail.stats?.videoCount || 0,
            verified: userDetail.user?.verified || false,
          };
        }
      } catch (e) { /* parse error, fall back to meta tags */ }
    }

    if (userData && userData.followers > 0) {
      const avgViews = userData.total_videos > 0 ? Math.round((userData.total_likes || 0) / userData.total_videos * 5) : 0;
      const engagementRate = userData.followers > 0 ? +((userData.total_likes / Math.max(userData.total_videos, 1)) / userData.followers * 100).toFixed(2) : 0;

      // Enhanced email discovery for TikTok bio
      const email = await discoverEmail(userData.bio || '', '');

      return {
        success: true,
        data: {
          display_name: userData.display_name || username,
          avatar_url: userData.avatar_url,
          bio: userData.bio,
          followers: userData.followers,
          following: userData.following,
          engagement_rate: Math.min(engagementRate, 30), // cap unreasonable values
          avg_views: avgViews,
          total_videos: userData.total_videos,
          category: detectCategory(userData.bio),
          country: '',
          language: '',
          email,
        },
      };
    }

    // Fallback: use what we got from meta tags
    if (followers > 0 || ogImage) {
      const email = await discoverEmail(ogDesc || '', '');
      return {
        success: true,
        partial: true,
        data: {
          display_name: ogTitle?.replace(/ \(@.*\).*$/, '') || username,
          avatar_url: ogImage || '',
          bio: ogDesc,
          followers,
          following: 0,
          engagement_rate: 0,
          avg_views: 0,
          total_videos: 0,
          category: detectCategory(ogDesc),
          country: '',
          language: '',
          email,
        },
      };
    }

    return {
      success: false,
      error: 'Could not fetch TikTok profile data. TikTok may be blocking server requests. Configure MODASH_API_KEY for reliable TikTok data.',
    };
  } catch (e) {
    return { success: false, error: `TikTok fetch error: ${e.message}. Configure MODASH_API_KEY for reliable data.` };
  }
}

// ==================== Instagram ====================

async function scrapeInstagram(profileUrl, username) {
  if (MODASH_API_KEY) {
    return scrapeViaModash(username, 'instagram');
  }

  // Instagram aggressively blocks server-side requests.
  // Without Modash or similar, we can only return what we extract from the URL.
  return {
    success: false,
    error: 'Instagram requires MODASH_API_KEY for profile data (Meta blocks direct server requests).',
  };
}

// ==================== Twitch Helix API (free) ====================

async function scrapeTwitch(profileUrl, username) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { success: false, error: 'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET not configured. Get them at dev.twitch.tv' };
  }

  try {
    // Get OAuth token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    });
    const tokenData = await tokenRes.json();

    // Get user data
    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    const user = userData.data?.[0];

    if (!user) return { success: false, error: 'Twitch user not found' };

    // Get follower count
    const followRes = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}`, {
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const followData = await followRes.json();

    return {
      success: true,
      data: {
        display_name: user.display_name,
        avatar_url: user.profile_image_url,
        bio: user.description || '',
        followers: followData.total || 0,
        following: 0,
        engagement_rate: 0,
        avg_views: 0,
        total_videos: 0,
        category: user.broadcaster_type === 'partner' ? 'Gaming' : 'Entertainment',
        country: '',
        language: '',
        email: await discoverEmail(user.description || '', ''),
      },
    };
  } catch (e) {
    return { success: false, error: `Twitch API error: ${e.message}` };
  }
}

// ==================== X/Twitter ====================

async function scrapeX(profileUrl, username) {
  // X/Twitter API v2 requires expensive paid access ($100+/month)
  return {
    success: false,
    error: 'X/Twitter API requires paid access ($100+/month). Set up at developer.x.com',
  };
}

// ==================== Modash (paid, covers all platforms) ====================

async function scrapeViaModash(username, platform) {
  if (!MODASH_API_KEY) {
    return { success: false, error: 'MODASH_API_KEY not configured' };
  }

  try {
    const res = await fetch(`https://api.modash.io/v1/profile?username=${username}&platform=${platform}`, {
      headers: { 'Authorization': `Bearer ${MODASH_API_KEY}` },
    });
    const data = await res.json();

    if (!data.profile) {
      return { success: false, error: data.error || 'Profile not found on Modash' };
    }

    const p = data.profile;
    return {
      success: true,
      data: {
        display_name: p.fullname || p.username,
        avatar_url: p.picture,
        bio: p.description || '',
        followers: p.followers || 0,
        following: p.following || 0,
        engagement_rate: +(p.engagementRate || 0).toFixed(2),
        avg_views: p.avgViews || p.avgReelsPlays || 0,
        total_videos: p.postsCount || 0,
        category: p.interests?.[0]?.name || detectCategory(p.description || ''),
        country: p.country || '',
        language: p.language || '',
        email: p.contacts?.email || extractEmailFromText(p.description || ''),
      },
    };
  } catch (e) {
    return { success: false, error: `Modash API error: ${e.message}` };
  }
}

// ==================== Enhanced Contact Discovery ====================

/**
 * Multi-strategy email discovery:
 * 1. Direct text regex (existing)
 * 2. Extract URLs from bio/description → follow Linktree/bio links → parse for emails
 * 3. Follow personal website links → scrape for contact emails
 * 4. Hunter.io domain search (if API key configured)
 */

const BIO_LINK_DOMAINS = [
  'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co', 'linkin.bio',
  'lnk.bio', 'tap.bio', 'campsite.bio', 'hoo.be', 'stan.store',
  'linkr.bio', 'withkoji.com', 'snipfeed.co', 'msha.ke', 'allmylinks.com',
  'direct.me', 'flow.page', 'jot.bio', 'about.me',
];

// Extract all URLs from text
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  return (text.match(urlRegex) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
}

// Determine if a URL is a bio link service
function isBioLinkUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return BIO_LINK_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// Determine if a URL is likely a personal/business website (not social media)
function isPersonalWebsite(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    const socialDomains = [
      'youtube.com', 'tiktok.com', 'instagram.com', 'twitter.com', 'x.com',
      'facebook.com', 'twitch.tv', 'discord.gg', 'discord.com', 'reddit.com',
      'patreon.com', 'ko-fi.com', 'paypal.com', 'paypal.me', 'gofundme.com',
      'amazon.com', 'amzn.to', 'bit.ly', 'tee.pub', 'merch.amazon.com',
      'open.spotify.com', 'music.apple.com', 'soundcloud.com',
      'github.com', 'medium.com', 'substack.com',
    ];
    // Also skip known bio link services (handled separately)
    if (BIO_LINK_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
    return !socialDomains.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// Scrape a Linktree/bio link page for email addresses
async function scrapeLinktreeForEmail(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const html = await res.text();

    // 1. Check for mailto: links
    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (mailtoMatch) return mailtoMatch[1];

    // 2. Check for email in link text/titles
    const emailInText = extractEmailFromText(html);
    if (emailInText) return emailInText;

    // 3. Parse Linktree JSON data if present
    const jsonMatch = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const links = data?.props?.pageProps?.links || data?.props?.pageProps?.account?.links || [];
        for (const link of links) {
          const linkUrl = link.url || link.link || '';
          if (linkUrl.includes('mailto:')) {
            const email = linkUrl.replace('mailto:', '').split('?')[0];
            if (email.includes('@')) return email;
          }
          const titleEmail = extractEmailFromText(link.title || '');
          if (titleEmail) return titleEmail;
        }
      } catch {}
    }

    return '';
  } catch {
    return '';
  }
}

// Scrape a personal website for contact email
async function scrapeWebsiteForEmail(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const html = await res.text();

    // Check for mailto: first (most reliable)
    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (mailtoMatch) return mailtoMatch[1];

    // Extract all emails from page, filter out common false positives
    const allEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const filtered = allEmails.filter(e => {
      const lower = e.toLowerCase();
      // Skip common false positives
      if (lower.includes('example.com') || lower.includes('sentry.io') || lower.includes('wixpress')) return false;
      if (lower.includes('.png') || lower.includes('.jpg') || lower.includes('.svg')) return false;
      if (lower.endsWith('.js') || lower.endsWith('.css') || lower.endsWith('.map')) return false;
      return true;
    });

    // Prefer business-looking emails
    const bizEmail = filtered.find(e => /^(contact|info|hello|business|collab|partner|inquir|press|media|book)/i.test(e));
    if (bizEmail) return bizEmail;

    return filtered[0] || '';
  } catch {
    return '';
  }
}

// Hunter.io domain search (if API key configured)
async function hunterDomainSearch(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return '';
  try {
    const res = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${apiKey}&limit=5`);
    const data = await res.json();
    if (data.data?.emails?.length > 0) {
      // Return highest confidence email
      const sorted = data.data.emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      return sorted[0].value;
    }
    return '';
  } catch {
    return '';
  }
}

// Main: discover email using all available methods
async function discoverEmail(text, existingEmail) {
  // If we already have an email from direct regex, return it
  if (existingEmail) return existingEmail;

  const directEmail = extractEmailFromText(text);
  if (directEmail) return directEmail;

  // Extract all URLs from the text
  const urls = extractUrls(text);
  if (urls.length === 0) return '';

  // Try bio link services first (Linktree etc.)
  for (const url of urls) {
    if (isBioLinkUrl(url)) {
      const email = await scrapeLinktreeForEmail(url);
      if (email) {
        console.log(`[ContactDiscovery] Found email via bio link (${url}): ${email}`);
        return email;
      }
    }
  }

  // Try personal/business websites
  for (const url of urls) {
    if (isPersonalWebsite(url)) {
      const email = await scrapeWebsiteForEmail(url);
      if (email) {
        console.log(`[ContactDiscovery] Found email via website (${url}): ${email}`);
        return email;
      }

      // Try Hunter.io for the domain
      try {
        const domain = new URL(url).hostname.replace('www.', '');
        const hunterEmail = await hunterDomainSearch(domain);
        if (hunterEmail) {
          console.log(`[ContactDiscovery] Found email via Hunter.io (${domain}): ${hunterEmail}`);
          return hunterEmail;
        }
      } catch {}
    }
  }

  return '';
}

// ==================== Helpers ====================

function parseAbbreviatedNumber(str) {
  if (!str) return 0;
  str = str.toString().trim();
  const num = parseFloat(str);
  if (str.endsWith('B') || str.endsWith('b')) return Math.round(num * 1e9);
  if (str.endsWith('M') || str.endsWith('m')) return Math.round(num * 1e6);
  if (str.endsWith('K') || str.endsWith('k')) return Math.round(num * 1e3);
  return Math.round(num) || 0;
}

function extractEmailFromText(text) {
  if (!text) return '';
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : '';
}

function detectCategory(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const categories = [
    { name: 'Gaming', keywords: ['game', 'gaming', 'gamer', 'esport', 'twitch', 'play', 'streamer', 'fps', 'rpg', 'moba'] },
    { name: 'Tech', keywords: ['tech', 'technology', 'software', 'code', 'programming', 'ai', 'developer', 'gadget', 'review'] },
    { name: 'Entertainment', keywords: ['entertainment', 'comedy', 'funny', 'vlog', 'daily', 'content creator'] },
    { name: 'Music', keywords: ['music', 'musician', 'singer', 'rapper', 'producer', 'dj', 'artist', 'song'] },
    { name: 'Education', keywords: ['education', 'tutorial', 'learn', 'teach', 'course', 'academy'] },
    { name: 'Finance', keywords: ['finance', 'crypto', 'trading', 'invest', 'money', 'stock', 'defi'] },
    { name: 'Lifestyle', keywords: ['lifestyle', 'fashion', 'beauty', 'travel', 'food', 'fitness', 'health'] },
  ];

  let best = { name: '', score: 0 };
  for (const cat of categories) {
    const score = cat.keywords.filter(k => lower.includes(k)).length;
    if (score > best.score) best = { name: cat.name, score };
  }
  return best.name;
}

// ==================== Main dispatcher ====================

async function scrapeProfile(profileUrl, platform, username) {
  switch (platform) {
    case 'youtube': return scrapeYouTube(profileUrl, username);
    case 'tiktok': return scrapeTikTok(profileUrl, username);
    case 'instagram': return scrapeInstagram(profileUrl, username);
    case 'twitch': return scrapeTwitch(profileUrl, username);
    case 'x': return scrapeX(profileUrl, username);
    default: return { success: false, error: `Unsupported platform: ${platform}` };
  }
}

function getApiStatus() {
  return {
    youtube: !!YOUTUBE_API_KEY,
    tiktok: !!MODASH_API_KEY,
    instagram: !!MODASH_API_KEY,
    twitch: !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
    x: false, // requires expensive paid API
    modash: !!MODASH_API_KEY,
  };
}

module.exports = {
  scrapeProfile,
  getApiStatus,
  scrapeYouTube,
  scrapeTikTok,
  scrapeInstagram,
  scrapeTwitch,
  discoverEmail,
  extractEmailFromText,
};
