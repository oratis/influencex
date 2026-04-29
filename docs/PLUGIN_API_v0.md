# Plugin API Spec — v0 (internal)

> **Status**: internal-only spec. Not exposed to third parties yet. Sprint Q2
> task D4. The intent is to give us a stable contract before we refactor
> `agents-v2/` → `agents-v3/` so the cleanup doesn't have to hold up against
> hypothetical external developers.
>
> Once stabilized for 2 internal sprints, we'll re-evaluate exposing this
> for community plugins. Until then, **do not** assume any of these
> interfaces are frozen.

---

## 0. Goals

- Decouple agent code from `server/index.js`. Each agent should be a
  self-contained module that doesn't reach into routes / DB schema /
  other agents directly.
- Allow new behaviors (a new agent, a new actor, a new email provider) to
  ship as a single new file plus a registry entry — no scattered edits.
- Keep the contract narrow. v0 covers the 3 plugin shapes we already
  use heavily; everything else stays as-is until a real third use case
  emerges.

## 1. Plugin shapes

### 1.1 `Agent` (LLM-driven workers)

Today: `server/agents-v2/*.js` — 16 modules registered via `registerAll()`
in `server/agents-v2/index.js`.

```js
module.exports = {
  // identity
  id: 'review-miner',                  // unique slug, used in logs + URLs
  name: 'Review Miner',
  description: '...',
  version: '1.0.0',
  capabilities: ['reviews.mine'],      // future: capability-based discovery

  // contract
  inputSchema: { type: 'object', ... }, // JSON Schema 7
  outputSchema: { type: 'object', ... },

  // optional: estimate cost before running, enables UI confirmation prompts
  costEstimate(input) { return { tokens: 1200, usdCents: 5 }; },

  // run: ctx provides emit() (SSE), llm, db helpers, sentry, workspaceId
  async run(input, ctx) { /* ... */ return result; },
};
```

**`ctx` provided by the runtime** (see `server/agent-runtime/index.js`):

| Field | Purpose |
|---|---|
| `ctx.workspaceId` | Tenant id; pass to apify/db calls for quota + scoping |
| `ctx.userId` | The user who initiated the run |
| `ctx.emit(event, data)` | Push progress to SSE listeners. `event` ∈ `{progress, partial, complete, error}` |
| `ctx.llm.complete({...})` | Provider-routed LLM call (auto-fallback) |
| `ctx.db.query(sql, params)` / `ctx.db.exec(...)` | Workspace-scoped DB |
| `ctx.cache.get(k)` / `ctx.cache.set(k, v, ttl)` | Shared cache (Redis or in-process) |
| `ctx.sentry.captureException(err)` | Direct Sentry hook for non-throw errors |

**Stability**: the `ctx` field set is **frozen** for v0. Adding new fields is
non-breaking; removing or renaming requires a v1 bump.

### 1.2 `ApifyActor` (scraping adapter)

Today: `server/apify-actors/*.js` — 5 modules (`instagram-profile`,
`instagram-hashtag`, `tiktok-profile`, `tiktok-hashtag`, `youtube-channel`).

```js
module.exports = {
  actorId: 'apify/instagram-profile-scraper',  // exact slug Apify expects
  platform: 'instagram',
  kind: 'profile',                             // profile | discovery | comments | reviews | ads
  costPerRunUsd: 0.0023,                       // for ops dashboards

  buildInput(opts) { /* opts → actor input payload */ },
  normalize(rawDatasetItem, opts) { /* raw → unified KOL/post/comment shape */ },
};
```

Drop a new file in `server/apify-actors/`, register in `index.js`, done. No
edits to `apify-client.js`, no edits to discovery dispatcher (kind-based).

### 1.3 `JobHandler` (async work)

Today: `server/email-jobs.js`, `server/scheduled-publish.js` — registered
via `jobQueue.register('email.send', handler)`.

```js
// At server boot, the wiring module:
queue.register('email.send', async ({ id, type, payload, attempt }) => {
  // payload validated against the job's schema
  const result = await doTheWork(payload);
  return result; // success
  // throw to retry (BullMQ honors attempts + exponential backoff)
});
```

**Conventions** (not enforced, but expected):

- `payload` is JSON-serializable
- `payload.workspaceId` always present for tenant-scoped work
- Idempotency key in `payload.dedup_key` when applicable; handler should
  short-circuit on duplicate

## 2. What stays out of v0

| Out of scope | Why |
|---|---|
| **Hot reload** | Not needed when we control all plugin authors. Restart the server. |
| **Sandboxing / isolation** | Internal plugins are fully trusted. v0 runs them in the main process. |
| **Permission model** | Agent gets full `ctx` access; no opt-in scopes yet. |
| **Public registry / installer** | Plugins are committed source-controlled; no marketplace. |
| **Versioning negotiation** | All plugins re-deploy together with the host. |

## 3. Migration plan: v0 → agents-v3

- **Step 1** (this sprint): freeze the `ctx` shape. Add types via JSDoc.
- **Step 2**: refactor 1 agent (`research`) to use only `ctx.*` for I/O —
  no direct `require('../llm')` or `require('../database')`. Verify tests
  still pass.
- **Step 3**: replicate for the other 15 agents one by one.
- **Step 4**: rename folder `agents-v2/` → `agents-v3/` once nothing imports
  hosts directly. Update `agent-runtime/index.js` to register from the
  new path.

Estimated effort: **~3 days** spread over Sprint 3.

## 4. Why this is internal only (today)

- **No backwards-compat commitment**: if we want to change `ctx.emit` next
  week, we just do it.
- **No security review**: agents have direct DB access. Opening to third
  parties requires a permission model first (see §2).
- **Brand risk**: a buggy third-party agent could send spam emails under
  our domain. Out of scope for an MIT-licensed product without a
  marketplace contract.

## 5. Companion docs

- [`MULTITENANCY.md`](./MULTITENANCY.md) — every plugin must respect
  `workspace_id` scoping. v0 enforces this at the `ctx.db` layer (queries
  go through `scoped(workspaceId)`).
- [`docs/ROADMAP_2026-Q2.md`](./ROADMAP_2026-Q2.md) — D4 task this spec
  closes.

---

**Last updated**: 2026-04-30
**Reviewed by**: maintainers (internal review)
**Open for external comment**: not yet
