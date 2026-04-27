/**
 * Apify usage quota tracker.
 *
 * Apify charges per actor run + per dataset item returned. We don't have a
 * real-time billing API, so we track call count + items count per UTC day and
 * gate on a soft daily ceiling.
 *
 * Two scopes:
 *   - **Global** (process-wide): `APIFY_DAILY_RUN_QUOTA` + `APIFY_DAILY_ITEMS_QUOTA`
 *     bound the platform's total daily Apify spend.
 *   - **Per-workspace**: `APIFY_WORKSPACE_DAILY_RUN_QUOTA` +
 *     `APIFY_WORKSPACE_DAILY_ITEMS_QUOTA` prevent a single workspace from
 *     exhausting the platform-wide budget. Pass `workspaceId` to canCall/record
 *     to enable; omitting it means global-only checking (legacy callers).
 *
 * Aligned in shape with youtube-quota.js so the discovery dispatcher can
 * call canCall/record/status uniformly across platforms.
 *
 * NOTE: in-memory only. Cloud Run with `--max-instances > 1` will see drift
 *       between replicas. Sprint 1 task A4 (Redis) will move this to a shared
 *       store; until then we run with max-instances=1.
 */

const DAILY_RUN_QUOTA = parseInt(process.env.APIFY_DAILY_RUN_QUOTA) || 200;
const DAILY_ITEMS_QUOTA = parseInt(process.env.APIFY_DAILY_ITEMS_QUOTA) || 10000;
const WS_DAILY_RUN_QUOTA = parseInt(process.env.APIFY_WORKSPACE_DAILY_RUN_QUOTA) || 50;
const WS_DAILY_ITEMS_QUOTA = parseInt(process.env.APIFY_WORKSPACE_DAILY_ITEMS_QUOTA) || 2000;
const SAFETY_MARGIN = 0.9;

let state = {
  date: currentDateKey(),
  runs: 0,
  items: 0,
  byActor: {},
  byWorkspace: {}, // wsId -> { runs, items }
};

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = currentDateKey();
  if (state.date !== today) {
    state = { date: today, runs: 0, items: 0, byActor: {}, byWorkspace: {} };
  }
}

function effectiveLimits() {
  return {
    runLimit: Math.floor(DAILY_RUN_QUOTA * SAFETY_MARGIN),
    itemsLimit: Math.floor(DAILY_ITEMS_QUOTA * SAFETY_MARGIN),
    wsRunLimit: Math.floor(WS_DAILY_RUN_QUOTA * SAFETY_MARGIN),
    wsItemsLimit: Math.floor(WS_DAILY_ITEMS_QUOTA * SAFETY_MARGIN),
  };
}

/**
 * Check whether an actor run is allowed under the current daily quotas.
 * `expectedItems` is best-effort — pass the resultsLimit you'll request so
 * we can refuse a run that would obviously blow the items budget.
 * `workspaceId` (optional) enables per-workspace check on top of global.
 */
function canCall(actorId, expectedItems = 50, workspaceId = null) {
  resetIfNewDay();
  const { runLimit, itemsLimit, wsRunLimit, wsItemsLimit } = effectiveLimits();
  const globalAllowed = state.runs + 1 <= runLimit && state.items + expectedItems <= itemsLimit;

  let wsAllowed = true;
  let wsState = { runs: 0, items: 0 };
  if (workspaceId) {
    wsState = state.byWorkspace[workspaceId] || { runs: 0, items: 0 };
    wsAllowed = wsState.runs + 1 <= wsRunLimit && wsState.items + expectedItems <= wsItemsLimit;
  }

  return {
    allowed: globalAllowed && wsAllowed,
    runs: state.runs,
    items: state.items,
    runLimit,
    itemsLimit,
    runRemaining: runLimit - state.runs,
    itemsRemaining: itemsLimit - state.items,
    workspace: workspaceId ? {
      runs: wsState.runs,
      items: wsState.items,
      runLimit: wsRunLimit,
      itemsLimit: wsItemsLimit,
      runRemaining: wsRunLimit - wsState.runs,
      itemsRemaining: wsItemsLimit - wsState.items,
    } : null,
    reason: !globalAllowed ? 'global_quota_exceeded' : !wsAllowed ? 'workspace_quota_exceeded' : null,
  };
}

/**
 * Record a completed Apify run. `itemsReturned` is the actual dataset size.
 * `workspaceId` (optional) attributes the cost to that tenant.
 */
function record(actorId, itemsReturned = 0, workspaceId = null) {
  resetIfNewDay();
  state.runs += 1;
  state.items += itemsReturned;
  if (!state.byActor[actorId]) state.byActor[actorId] = { runs: 0, items: 0 };
  state.byActor[actorId].runs += 1;
  state.byActor[actorId].items += itemsReturned;
  if (workspaceId) {
    if (!state.byWorkspace[workspaceId]) state.byWorkspace[workspaceId] = { runs: 0, items: 0 };
    state.byWorkspace[workspaceId].runs += 1;
    state.byWorkspace[workspaceId].items += itemsReturned;
  }
  return { runs: state.runs, items: state.items };
}

function status(workspaceId = null) {
  resetIfNewDay();
  const { runLimit, itemsLimit, wsRunLimit, wsItemsLimit } = effectiveLimits();
  const out = {
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
  if (workspaceId) {
    const ws = state.byWorkspace[workspaceId] || { runs: 0, items: 0 };
    out.workspace = {
      runs: ws.runs,
      items: ws.items,
      runLimit: wsRunLimit,
      itemsLimit: wsItemsLimit,
      runUtilization: ws.runs / wsRunLimit,
      itemsUtilization: ws.items / wsItemsLimit,
    };
  } else {
    out.byWorkspace = { ...state.byWorkspace };
  }
  return out;
}

// Test hook — reset state for deterministic unit tests.
function _resetForTest() {
  state = { date: currentDateKey(), runs: 0, items: 0, byActor: {}, byWorkspace: {} };
}

module.exports = { canCall, record, status, _resetForTest };
