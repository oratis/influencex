/**
 * YouTube API quota tracker.
 *
 * YouTube Data API v3 has a default daily quota of 10,000 units, resetting at
 * midnight Pacific Time. Different endpoints cost different amounts:
 *   - search.list        : 100 units
 *   - channels.list      : 1 unit
 *   - videos.list        : 1 unit
 *   - playlistItems.list : 1 unit
 *
 * We track usage in-memory per UTC day. On Cloud Run with multiple instances
 * each replica tracks independently — a DB-backed counter is a future upgrade.
 */

const DAILY_QUOTA = parseInt(process.env.YOUTUBE_QUOTA_DAILY) || 10000;
const SAFETY_MARGIN = 0.9; // reserve 10% headroom

const COSTS = {
  search: 100,
  channels: 1,
  videos: 1,
  playlistItems: 1,
};

let state = {
  date: currentDateKey(),
  used: 0,
  byEndpoint: {},
};

function currentDateKey() {
  // Use Pacific Time for quota reset alignment
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = currentDateKey();
  if (state.date !== today) {
    state = { date: today, used: 0, byEndpoint: {} };
  }
}

/**
 * Check whether a call of the given type is allowed under the current quota.
 * Returns { allowed, remaining, used, dailyLimit }.
 */
function canCall(endpoint, count = 1) {
  resetIfNewDay();
  const cost = (COSTS[endpoint] || 1) * count;
  const limit = Math.floor(DAILY_QUOTA * SAFETY_MARGIN);
  return {
    allowed: state.used + cost <= limit,
    cost,
    used: state.used,
    remaining: limit - state.used,
    dailyLimit: limit,
  };
}

/**
 * Record a successful API call's cost.
 */
function record(endpoint, count = 1) {
  resetIfNewDay();
  const cost = (COSTS[endpoint] || 1) * count;
  state.used += cost;
  state.byEndpoint[endpoint] = (state.byEndpoint[endpoint] || 0) + cost;
  return state.used;
}

/**
 * Get current quota status.
 */
function status() {
  resetIfNewDay();
  const limit = Math.floor(DAILY_QUOTA * SAFETY_MARGIN);
  return {
    date: state.date,
    used: state.used,
    dailyLimit: limit,
    rawQuota: DAILY_QUOTA,
    remaining: limit - state.used,
    utilization: state.used / limit,
    byEndpoint: { ...state.byEndpoint },
  };
}

module.exports = { canCall, record, status, COSTS };
