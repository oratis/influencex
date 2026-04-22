/**
 * Data Agent - scrapes engagement data from published content URLs
 * YouTube: uses Data API v3 for video statistics (including Shorts)
 * TikTok: uses oEmbed API + page scraping
 * Instagram: uses oEmbed API for basic data
 */

const fetch = require('../proxy-fetch');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

async function scrapeContentUrl(url) {
  if (!url) return null;

  try {
    const u = new URL(url);

    // YouTube video (including Shorts)
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      return scrapeYouTubeVideo(url);
    }

    // TikTok video
    if (u.hostname.includes('tiktok.com')) {
      return scrapeTikTokVideo(url);
    }

    // Instagram Reel/Post
    if (u.hostname.includes('instagram.com')) {
      return scrapeInstagramContent(url);
    }

    return null;
  } catch {
    return null;
  }
}

async function scrapeYouTubeVideo(url) {
  if (!YOUTUBE_API_KEY) return null;

  // Extract video ID from various YouTube URL formats
  let videoId = null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      videoId = u.pathname.slice(1).split('?')[0];
    } else if (u.pathname.startsWith('/shorts/')) {
      // YouTube Shorts: /shorts/VIDEO_ID
      videoId = u.pathname.split('/shorts/')[1]?.split('?')[0];
    } else if (u.pathname.startsWith('/embed/')) {
      videoId = u.pathname.split('/embed/')[1]?.split('?')[0];
    } else {
      videoId = u.searchParams.get('v');
    }
  } catch { return null; }

  if (!videoId) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    const video = data.items?.[0];
    if (!video) return null;

    return {
      platform: 'youtube',
      title: video.snippet?.title || '',
      views: parseInt(video.statistics?.viewCount) || 0,
      likes: parseInt(video.statistics?.likeCount) || 0,
      comments: parseInt(video.statistics?.commentCount) || 0,
      shares: 0,
      publish_date: video.snippet?.publishedAt?.split('T')[0] || '',
    };
  } catch (e) {
    console.warn('YouTube video scrape error:', e.message);
    return null;
  }
}

async function scrapeTikTokVideo(url) {
  try {
    // TikTok oEmbed API is free and doesn't need a key
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();

    // oEmbed doesn't give view counts directly, try fetching the page
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const html = await pageRes.text();

      // Try to extract from __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON
      const sigiMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
      if (sigiMatch) {
        try {
          const json = JSON.parse(sigiMatch[1]);
          const defaultScope = json.__DEFAULT_SCOPE__ || {};
          const videoDetail = defaultScope['webapp.video-detail']?.itemInfo?.itemStruct;
          if (videoDetail?.stats) {
            return {
              platform: 'tiktok',
              title: videoDetail.desc || data.title || '',
              views: videoDetail.stats.playCount || 0,
              likes: videoDetail.stats.diggCount || 0,
              comments: videoDetail.stats.commentCount || 0,
              shares: videoDetail.stats.shareCount || 0,
              publish_date: videoDetail.createTime ? new Date(videoDetail.createTime * 1000).toISOString().split('T')[0] : '',
            };
          }
        } catch { /* parse error */ }
      }
    } catch { clearTimeout(timeout); }

    // Fallback - return oEmbed data with zeros
    return {
      platform: 'tiktok',
      title: data.title || '',
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      publish_date: '',
    };
  } catch (e) {
    console.warn('TikTok video scrape error:', e.message);
    return null;
  }
}

async function scrapeInstagramContent(url) {
  try {
    // Instagram oEmbed API (requires App Token for full access, but basic works)
    // Try fetching the page directly first
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const html = await pageRes.text();

    // Try extracting from meta tags
    const viewsMatch = html.match(/\"video_view_count\":(\d+)/);
    const likesMatch = html.match(/\"edge_media_preview_like\":\{\"count\":(\d+)\}/);
    const commentsMatch = html.match(/\"edge_media_preview_comment\":\{\"count\":(\d+)\}/);
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/) ||
                        html.match(/<meta\s+content="([^"]*?)"\s+property="og:title"/);
    const playCountMatch = html.match(/\"play_count\":(\d+)/);

    const views = parseInt(viewsMatch?.[1] || playCountMatch?.[1]) || 0;
    const likes = parseInt(likesMatch?.[1]) || 0;
    const comments = parseInt(commentsMatch?.[1]) || 0;

    if (views > 0 || likes > 0) {
      return {
        platform: 'instagram',
        title: titleMatch?.[1] || '',
        views,
        likes,
        comments,
        shares: 0,
        publish_date: '',
      };
    }

    // If page scraping didn't work, return null (Instagram blocks most scraping)
    return null;
  } catch (e) {
    console.warn('Instagram scrape error:', e.message);
    return null;
  }
}

async function scrapeMultipleUrls(urls) {
  const results = [];
  for (const url of urls) {
    const result = await scrapeContentUrl(url);
    if (result) {
      results.push({ url, ...result });
    }
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

module.exports = { scrapeContentUrl, scrapeMultipleUrls };
