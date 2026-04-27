/**
 * Review harvesting + sentiment scoring (Phase D skeleton).
 *
 * Pulls user reviews from Steam / Apple App Store / Google Play via Apify
 * actors, runs each through a lightweight rule-based sentiment classifier,
 * and returns a normalized `{ reviews, sentiment }` shape that downstream
 * agents (review-miner, community) can consume.
 *
 * The LLM-based deep sentiment + topic clustering belongs in agents-v2/
 * review-miner; this module just gets the raw data + a coarse positive /
 * neutral / negative label. Keeps the scraping cost separate from LLM cost.
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const STEAM_ACTOR = process.env.APIFY_STEAM_REVIEWS_ACTOR_ID || 'easyapi/steam-reviews-scraper';
const APPSTORE_ACTOR = process.env.APIFY_APPSTORE_REVIEWS_ACTOR_ID || 'apify/app-store-scraper';
const PLAYSTORE_ACTOR = process.env.APIFY_PLAYSTORE_REVIEWS_ACTOR_ID || 'apify/google-play-scraper';

// Rough rule-based sentiment classifier. English-leaning. Returns one of:
//   { label: 'positive' | 'neutral' | 'negative', score: -1..1 }
const POSITIVE_WORDS = ['love', 'great', 'amazing', 'awesome', 'excellent', 'fantastic', 'perfect', 'best', 'beautiful', 'fun', 'addictive', 'recommend'];
const NEGATIVE_WORDS = ['hate', 'terrible', 'awful', 'broken', 'crash', 'bug', 'worst', 'bad', 'boring', 'waste', 'refund', 'scam', 'pay-to-win'];

function quickSentiment(text) {
  if (!text) return { label: 'neutral', score: 0 };
  const t = String(text).toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) if (t.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (t.includes(w)) score -= 1;
  // Normalize to -1..1
  const norm = Math.max(-1, Math.min(1, score / 3));
  let label = 'neutral';
  if (norm > 0.2) label = 'positive';
  else if (norm < -0.2) label = 'negative';
  return { label, score: norm };
}

function normalizeSteamReview(item) {
  if (!item) return null;
  const body = item.review || item.text || '';
  const sentiment = quickSentiment(body);
  return {
    platform: 'steam',
    review_id: String(item.recommendationid || item.id || ''),
    author_handle: item.author?.steamid || item.author_steamid || '',
    author_name: item.author?.persona_name || '',
    rating: item.voted_up ? 5 : 1,
    body,
    helpful_count: item.votes_up || 0,
    created_at: item.timestamp_created ? new Date(item.timestamp_created * 1000).toISOString() : null,
    sentiment,
  };
}

function normalizeAppStoreReview(item) {
  if (!item) return null;
  const body = item.review || item.body || '';
  const sentiment = quickSentiment(body);
  return {
    platform: 'app-store',
    review_id: String(item.id || ''),
    author_handle: item.userName || '',
    author_name: item.userName || '',
    rating: item.rating || item.score || 0,
    body,
    helpful_count: 0,
    created_at: item.date ? new Date(item.date).toISOString() : null,
    sentiment,
  };
}

function normalizePlayStoreReview(item) {
  if (!item) return null;
  const body = item.text || item.review || '';
  const sentiment = quickSentiment(body);
  return {
    platform: 'play-store',
    review_id: String(item.reviewId || item.id || ''),
    author_handle: item.userName || '',
    author_name: item.userName || '',
    rating: item.score || 0,
    body,
    helpful_count: item.thumbsUpCount || 0,
    created_at: item.at ? new Date(item.at).toISOString() : null,
    sentiment,
  };
}

async function harvestSteamReviews({ appId, limit = 200, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!appId) return { success: false, error: 'appId required' };
  const check = quota.canCall(STEAM_ACTOR, limit, workspaceId);
  if (!check.allowed) return { success: false, error: `Apify quota exceeded (${check.reason})` };
  const r = await apify.runActor(STEAM_ACTOR, {
    startUrls: [{ url: `https://store.steampowered.com/app/${appId}/` }],
    maxReviews: limit,
  }, { workspaceId });
  if (!r.success) return r;
  quota.record(STEAM_ACTOR, r.items?.length || 0, workspaceId);
  const reviews = (r.items || []).map(normalizeSteamReview).filter(Boolean);
  return { success: true, reviews, summary: summarize(reviews) };
}

async function harvestAppStoreReviews({ appId, country = 'us', limit = 200, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!appId) return { success: false, error: 'appId required' };
  const check = quota.canCall(APPSTORE_ACTOR, limit, workspaceId);
  if (!check.allowed) return { success: false, error: `Apify quota exceeded (${check.reason})` };
  const r = await apify.runActor(APPSTORE_ACTOR, {
    appIds: [appId],
    countryCode: country,
    maxReviews: limit,
  }, { workspaceId });
  if (!r.success) return r;
  quota.record(APPSTORE_ACTOR, r.items?.length || 0, workspaceId);
  const reviews = (r.items || []).map(normalizeAppStoreReview).filter(Boolean);
  return { success: true, reviews, summary: summarize(reviews) };
}

async function harvestPlayStoreReviews({ appId, country = 'us', limit = 200, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!appId) return { success: false, error: 'appId required' };
  const check = quota.canCall(PLAYSTORE_ACTOR, limit, workspaceId);
  if (!check.allowed) return { success: false, error: `Apify quota exceeded (${check.reason})` };
  const r = await apify.runActor(PLAYSTORE_ACTOR, {
    appIds: [appId],
    country,
    maxReviews: limit,
  }, { workspaceId });
  if (!r.success) return r;
  quota.record(PLAYSTORE_ACTOR, r.items?.length || 0, workspaceId);
  const reviews = (r.items || []).map(normalizePlayStoreReview).filter(Boolean);
  return { success: true, reviews, summary: summarize(reviews) };
}

function summarize(reviews) {
  let pos = 0, neu = 0, neg = 0;
  let totalRating = 0;
  for (const r of reviews) {
    if (r.sentiment.label === 'positive') pos++;
    else if (r.sentiment.label === 'negative') neg++;
    else neu++;
    totalRating += r.rating || 0;
  }
  const total = reviews.length;
  return {
    total,
    positive: pos,
    neutral: neu,
    negative: neg,
    avg_rating: total > 0 ? totalRating / total : 0,
    positive_pct: total > 0 ? Math.round((pos / total) * 100) : 0,
    negative_pct: total > 0 ? Math.round((neg / total) * 100) : 0,
  };
}

module.exports = {
  harvestSteamReviews,
  harvestAppStoreReviews,
  harvestPlayStoreReviews,
  normalizeSteamReview,
  normalizeAppStoreReview,
  normalizePlayStoreReview,
  quickSentiment,
  summarize,
  STEAM_ACTOR,
  APPSTORE_ACTOR,
  PLAYSTORE_ACTOR,
};
