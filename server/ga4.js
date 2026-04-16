/**
 * Google Analytics 4 Data API integration
 * Uses the GA4 Data API to pull website metrics (UV, sessions, etc.)
 *
 * Required env vars:
 * - GA4_PROPERTY_ID: numeric property ID (not measurement ID)
 * - GA4_CREDENTIALS_JSON: base64-encoded service account JSON, OR
 * - GOOGLE_APPLICATION_CREDENTIALS: path to service account JSON file
 *
 * The measurement ID G-4H57DW4Y3G is for client-side gtag.js tracking.
 * The GA4 Data API requires the numeric property ID from GA4 Admin > Property Settings.
 */

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_API_SECRET = process.env.GA4_API_SECRET;
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || 'G-4H57DW4Y3G';

// For the Data API, we need a service account.
// If not available, we provide a lighter integration using the Measurement Protocol
// or return mock/demo data with instructions.

function isConfigured() {
  return !!(GA4_PROPERTY_ID && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GA4_CREDENTIALS_JSON));
}

let analyticsClient = null;

async function getClient() {
  if (analyticsClient) return analyticsClient;

  try {
    const { BetaAnalyticsDataClient } = require('@google-analytics/data');

    if (process.env.GA4_CREDENTIALS_JSON) {
      const creds = JSON.parse(Buffer.from(process.env.GA4_CREDENTIALS_JSON, 'base64').toString());
      analyticsClient = new BetaAnalyticsDataClient({ credentials: creds });
    } else {
      analyticsClient = new BetaAnalyticsDataClient();
    }
    return analyticsClient;
  } catch (e) {
    console.warn('GA4 Data API client not available:', e.message);
    return null;
  }
}

async function getWebsiteMetrics(startDate = '30daysAgo', endDate = 'today') {
  if (!isConfigured()) return { configured: false, data: [] };

  const client = await getClient();
  if (!client) return { configured: false, data: [] };

  try {
    const [response] = await client.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'averageSessionDuration' },
        { name: 'bounceRate' },
        { name: 'newUsers' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    });

    const data = (response.rows || []).map(row => ({
      date: formatGADate(row.dimensionValues[0].value),
      activeUsers: parseInt(row.metricValues[0].value) || 0,
      sessions: parseInt(row.metricValues[1].value) || 0,
      pageViews: parseInt(row.metricValues[2].value) || 0,
      avgSessionDuration: parseFloat(row.metricValues[3].value) || 0,
      bounceRate: parseFloat(row.metricValues[4].value) || 0,
      newUsers: parseInt(row.metricValues[5].value) || 0,
    }));

    const totals = response.totals?.[0]?.metricValues || [];
    return {
      configured: true,
      data,
      totals: {
        activeUsers: parseInt(totals[0]?.value) || 0,
        sessions: parseInt(totals[1]?.value) || 0,
        pageViews: parseInt(totals[2]?.value) || 0,
        avgSessionDuration: parseFloat(totals[3]?.value) || 0,
        bounceRate: parseFloat(totals[4]?.value) || 0,
        newUsers: parseInt(totals[5]?.value) || 0,
      },
    };
  } catch (e) {
    console.error('GA4 metrics error:', e.message);
    return { configured: true, error: e.message, data: [] };
  }
}

async function getTrafficSources(startDate = '30daysAgo', endDate = 'today') {
  if (!isConfigured()) return { configured: false, data: [] };

  const client = await getClient();
  if (!client) return { configured: false, data: [] };

  try {
    const [response] = await client.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionSourceMedium' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'conversions' },
      ],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 20,
    });

    return {
      configured: true,
      data: (response.rows || []).map(row => ({
        source: row.dimensionValues[0].value,
        activeUsers: parseInt(row.metricValues[0].value) || 0,
        sessions: parseInt(row.metricValues[1].value) || 0,
        conversions: parseInt(row.metricValues[2].value) || 0,
      })),
    };
  } catch (e) {
    console.error('GA4 traffic sources error:', e.message);
    return { configured: true, error: e.message, data: [] };
  }
}

async function getRealtimeUsers() {
  if (!isConfigured()) return { configured: false, activeUsers: 0 };

  const client = await getClient();
  if (!client) return { configured: false, activeUsers: 0 };

  try {
    const [response] = await client.runRealtimeReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      metrics: [{ name: 'activeUsers' }],
    });

    return {
      configured: true,
      activeUsers: parseInt(response.rows?.[0]?.metricValues?.[0]?.value) || 0,
    };
  } catch (e) {
    console.error('GA4 realtime error:', e.message);
    return { configured: true, error: e.message, activeUsers: 0 };
  }
}

// Generate demo GA4 data when not configured
function getDemoMetrics() {
  const data = [];
  for (let d = 30; d >= 0; d--) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split('T')[0];
    const base = 50 + Math.floor((30 - d) * 2.5);
    data.push({
      date: dateStr,
      activeUsers: base + Math.floor(Math.random() * 40),
      sessions: Math.floor(base * 1.3 + Math.random() * 50),
      pageViews: Math.floor(base * 3.5 + Math.random() * 100),
      avgSessionDuration: 120 + Math.random() * 180,
      bounceRate: 35 + Math.random() * 20,
      newUsers: Math.floor(base * 0.6 + Math.random() * 20),
    });
  }
  const totals = {
    activeUsers: data.reduce((s, d) => s + d.activeUsers, 0),
    sessions: data.reduce((s, d) => s + d.sessions, 0),
    pageViews: data.reduce((s, d) => s + d.pageViews, 0),
    avgSessionDuration: data.reduce((s, d) => s + d.avgSessionDuration, 0) / data.length,
    bounceRate: data.reduce((s, d) => s + d.bounceRate, 0) / data.length,
    newUsers: data.reduce((s, d) => s + d.newUsers, 0),
  };
  return { configured: false, demo: true, data, totals };
}

function getDemoTrafficSources() {
  return {
    configured: false,
    demo: true,
    data: [
      { source: 'google / organic', activeUsers: 850, sessions: 1200, conversions: 45 },
      { source: '(direct) / (none)', activeUsers: 620, sessions: 800, conversions: 30 },
      { source: 'tiktok / referral', activeUsers: 340, sessions: 480, conversions: 22 },
      { source: 'youtube / referral', activeUsers: 280, sessions: 350, conversions: 18 },
      { source: 'twitter / social', activeUsers: 150, sessions: 200, conversions: 8 },
      { source: 'instagram / referral', activeUsers: 120, sessions: 160, conversions: 6 },
    ],
  };
}

function formatGADate(dateStr) {
  // GA returns YYYYMMDD, convert to YYYY-MM-DD
  if (dateStr && dateStr.length === 8) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  return dateStr;
}

module.exports = {
  isConfigured,
  getWebsiteMetrics,
  getTrafficSources,
  getRealtimeUsers,
  getDemoMetrics,
  getDemoTrafficSources,
  GA4_MEASUREMENT_ID,
};
