/**
 * Discovery Agent - finds KOLs matching campaign criteria
 * Uses YouTube Data API v3 search for channel discovery
 */

const fetch = require('../proxy-fetch');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

function detectCategory(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const categories = [
    { name: 'Gaming', keywords: ['game', 'gaming', 'gamer', 'esport', 'play', 'streamer', 'fps', 'rpg', 'moba', 'minecraft', 'fortnite', 'valorant'] },
    { name: 'AI', keywords: ['ai', 'artificial intelligence', 'machine learning', 'chatbot', 'roleplay', 'character ai', 'npc', 'ai companion'] },
    { name: 'Tech', keywords: ['tech', 'technology', 'software', 'code', 'programming', 'developer', 'gadget', 'review'] },
  ];
  let best = { name: '', score: 0 };
  for (const cat of categories) {
    const score = cat.keywords.filter(k => lower.includes(k)).length;
    if (score > best.score) best = { name: cat.name, score };
  }
  return best.name;
}

function calculateRelevance(channel, keywords) {
  let score = 0;
  const text = `${channel.title} ${channel.description}`.toLowerCase();
  const keywordList = keywords.toLowerCase().split(/[,\s]+/).filter(Boolean);

  for (const kw of keywordList) {
    if (text.includes(kw)) score += 20;
  }

  // Bonus for gaming + AI combination
  const hasGaming = ['game', 'gaming', 'gamer'].some(k => text.includes(k));
  const hasAI = ['ai', 'roleplay', 'character', 'npc'].some(k => text.includes(k));
  if (hasGaming && hasAI) score += 30;
  if (hasGaming) score += 10;
  if (hasAI) score += 10;

  // Cap at 100
  return Math.min(100, score);
}

async function searchYouTubeChannels({ keywords, maxResults = 50, minSubscribers = 1000 }) {
  if (!YOUTUBE_API_KEY) {
    return { success: false, error: 'YOUTUBE_API_KEY not configured' };
  }

  const queries = keywords.split(',').map(k => k.trim()).filter(Boolean);
  const allChannels = new Map(); // dedupe by channelId

  for (const query of queries) {
    try {
      const searchRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults, 50)}&key=${YOUTUBE_API_KEY}`
      );
      const searchData = await searchRes.json();

      if (searchData.error) {
        console.warn(`YouTube search error for "${query}":`, searchData.error.message);
        continue;
      }

      const channelIds = (searchData.items || [])
        .map(item => item.id.channelId || item.snippet.channelId)
        .filter(Boolean);

      if (channelIds.length === 0) continue;

      // Get channel statistics in batch
      const statsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`
      );
      const statsData = await statsRes.json();

      for (const ch of (statsData.items || [])) {
        const subs = parseInt(ch.statistics?.subscriberCount) || 0;
        if (subs < minSubscribers) continue;
        if (allChannels.has(ch.id)) continue;

        const relevance = calculateRelevance(
          { title: ch.snippet.title, description: ch.snippet.description },
          keywords
        );

        allChannels.set(ch.id, {
          channelId: ch.id,
          platform: 'youtube',
          channel_url: `https://www.youtube.com/channel/${ch.id}`,
          channel_name: ch.snippet.title,
          avatar_url: ch.snippet.thumbnails?.high?.url || ch.snippet.thumbnails?.default?.url,
          description: (ch.snippet.description || '').slice(0, 300),
          subscribers: subs,
          total_videos: parseInt(ch.statistics?.videoCount) || 0,
          relevance_score: relevance,
          category: detectCategory(ch.snippet.title + ' ' + ch.snippet.description),
        });
      }

      // Rate limit between queries
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`Discovery search error for "${query}":`, e.message);
    }
  }

  // Sort by relevance, then subscribers
  const results = [...allChannels.values()]
    .sort((a, b) => b.relevance_score - a.relevance_score || b.subscribers - a.subscribers);

  return {
    success: true,
    channels: results,
    total: results.length,
  };
}

module.exports = { searchYouTubeChannels, calculateRelevance };
