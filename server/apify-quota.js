/**
 * Apify usage quota tracker.
 *
 * Apify charges per actor run + per dataset item returned. We don't have a
 * real-time billing API, so we track call count + items count per UTC day and
 * gate on a soft daily ceiling. Tune APIFY_DAILY_RUN_QUOTA and
 * APIFY_DAILY_ITEMS_QUOTA per your plan; both default to safe free-tier
 * values.
 *
 * Aligned in shape with youtube-quota.js so the discovery dispatcher can
 * call canCall/record/status uniformly across platforms.
 */

const DAILY_RUN_QUOTA = parseInt(process.env.APIFY_DAILY_RUN_QUOTA) || 200;
const DAILY_ITEMS_QUOTA = parseInt(process.env.APIFY_DAILY_ITEMS_QUOTA) || 10000;
const SAFETY_MARGIN = 0.9;

let state = {
  date: currentDateKey(),
  runs: 0,
  items: 0,
  byActor: {},
};

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = currentDateKey();
  if (state.date !== today) {
    state = { date: today, runs: 0, items: 0, byActor: {} };
  }
}

/**
 * Check whether an actor run is allowed under the current daily quota.
 * `expectedItems` is best-effort — pass the resultsLimit you'll request so
 * we can refuse a run that would obviously blow the items budget.
 */
function canCall(actorId, expectedItems = 50) {
  resetIfNewDay();
  const runLimit = Math.floor(DAILY_RUN_QUOTA * SAFETY_MARGIN);
  const itemsLimit = Math.floor(DAILY_ITEMS_QUOTA * SAFETY_MARGIN);
  const allowed = state.runs + 1 <= runLimit && state.items + expectedItems <= itemsLimit;
  return {
    allowed,
    runs: state.runs,
    items: state.items,
    runLimit,
    itemsLimit,
    runRemaining: runLimit - state.runs,
    itemsRemaining: itemsLimit - state.items,
  };
}

/**
 * Record a completed Apify run. `itemsReturned` is the actual dataset size.
 */
function record(actorId, itemsReturned = 0) {
  resetIfNewDay();
  state.runs += 1;
  state.items += itemsReturned;
  if (!state.byActor[actorId]) state.byActor[actorId] = { runs: 0, items: 0 };
  state.byActor[actorId].runs += 1;
  state.byActor[actorId].items += itemsReturned;
  return { runs: state.runs, items: state.items };
}

function status() {
  resetIfNewDay();
  const runLimit = Math.floor(DAILY_RUN_QUOTA * SAFETY_MARGIN);
  const itemsLimit = Math.floor(DAILY_ITEMS_QUOTA * SAFETY_MARGIN);
  return {
    date: state.date,
    runs: state.runs,
    items: state.items,
    runLimit,
    itemsLimit,
    rawRunQuota: DAILY_RUN_QUOTA,
    rawItemsQuota: DAILY_ITEMS_QUOTA,
    runUtilization: state.runs / runLimit,
    itemsUtilization: state.items / itemsLimit,
    byActor: { ...state.byActor },
  };
}

// Test hook — reset state for deterministic unit tests.
function _resetForTest() {
  state = { date: currentDateKey(), runs: 0, items: 0, byActor: {} };
}

module.exports = { canCall, record, status, _resetForTest };
