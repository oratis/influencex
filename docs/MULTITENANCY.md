# Multi-tenancy design & migration plan

**Decision:** Multi-tenancy ships in **Phase A, week 1**. Every table in the v2 data model — existing and new — carries a `workspace_id`. Every query is scoped.

This doc is the spec. Follow it literally when building.

---

## 1. What changes

### 1.1 Concept

- **User** — a human with an email + password. Today, also the top-level owner of all data. In v2, they're an identity that can belong to many workspaces.
- **Workspace** — a tenant. For one user = their own account; for an agency = one workspace per client brand; for an enterprise = one per product line.
- **Membership** — `(user, workspace, role)` tuple. Roles (admin/editor/viewer) now apply **per workspace**, not globally.

One user, many workspaces. One workspace, many users (agency scenario). Data never crosses.

### 1.2 Data layout

Every business table gains `workspace_id TEXT NOT NULL` + index + foreign key. Existing rows get backfilled into a default "Legacy" workspace during migration.

Tables that **don't** get `workspace_id`:
- `users` — a user is global identity; workspaces reference them
- `sessions` — tied to user, not workspace
- `workspaces` — obviously
- `workspace_members` — the join table itself
- `schema_migrations` — internal
- `email_templates` (built-in defaults) — shared; custom templates per workspace go in separate table

Tables that **do** get `workspace_id` (20 tables):
`campaigns`, `kols`, `kol_database`, `contacts`, `pipeline_jobs`, `content_data`, `content_daily_stats`, `content_scrape_cache`, `registration_data`, `dashboard_events`, `discovery_jobs`, `discovery_results`, `email_replies`, plus all v2 new tables (`agents`, `agent_runs`, `agent_traces`, `content_pieces`, `content_variants`, `brand_voices`, `channel_connections`, `scheduled_posts`).

---

## 2. Schema

```sql
-- New tables

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE,                      -- used in subdomain or path
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  plan          TEXT DEFAULT 'starter',           -- starter|growth|scale|enterprise
  created_at    TIMESTAMP DEFAULT NOW(),
  deleted_at    TIMESTAMP,                        -- soft delete
  settings      JSONB DEFAULT '{}'
);
CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'editor',    -- admin|editor|viewer
  joined_at    TIMESTAMP DEFAULT NOW(),
  invited_by   TEXT REFERENCES users(id),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON workspace_members(user_id);

-- Every existing business table: add workspace_id + index + FK
ALTER TABLE campaigns       ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE kols            ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
-- ...20 tables total
CREATE INDEX idx_campaigns_workspace   ON campaigns(workspace_id);
CREATE INDEX idx_kols_workspace        ON kols(workspace_id);
-- ...
```

After backfill completes and app is on v2, tighten:

```sql
ALTER TABLE campaigns       ALTER COLUMN workspace_id SET NOT NULL;
-- ...
```

---

## 3. Migration strategy

A single forward migration, atomic where possible. Runs on server startup via the existing `server/migrations.js` framework.

```
Migration 2026-04-18-multitenancy:

  STEP 1: Create workspaces, workspace_members tables.
  STEP 2: For each existing user U:
            INSERT INTO workspaces (id, name, owner_user_id) VALUES
              (uuid(), U.name + "'s workspace", U.id);
            INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
              (that_id, U.id, 'admin');
  STEP 3: If any rows exist in business tables without an owner (common for
          seed data): create ONE default workspace called "Legacy".
            Pick any existing admin (or create one) as owner_user_id.
          Backfill all orphan rows with this workspace_id.
  STEP 4: For rows created by known users (future-proofing), set workspace_id
          to that user's first workspace.
  STEP 5: After backfill, ALTER COLUMN ... SET NOT NULL on all workspace_id columns.
```

**For users already using InfluenceX** (you, today):
- Exactly one workspace gets auto-created for `oratis@hakko.ai` named "Hakko AI"
- All your campaigns/KOLs/contacts get attached to it
- Next login: Workspace switcher shows only "Hakko AI" — zero visible change
- You can later invite teammates and/or create additional workspaces

Migration is **idempotent**: if re-run (e.g. after restore from backup) it skips what already exists.

Rollback: The `workspaces` tables stay; `workspace_id` columns stay; we just don't enforce `NOT NULL` if we need to revert the app code. No destructive changes.

---

## 4. Query scoping (the non-negotiable rule)

**Every SELECT / UPDATE / DELETE on a business table MUST include `workspace_id = $current`.**

To enforce this without relying on developer discipline, we add one of three layers:

### Option A — Scoped query helper (our choice)

Wrap `query/queryOne/exec` in a workspace-aware variant:

```javascript
// server/database.js — additions

function scoped(workspaceId) {
  if (!workspaceId) throw new Error('workspace context required');
  return {
    query: (sql, params) => {
      // Auto-inject workspace_id into WHERE if missing? Too magical.
      // Instead: always pass it explicitly; the helper asserts inclusion.
      assertContainsWorkspaceScope(sql);
      return query(sql, params);
    },
    // ... queryOne, exec, transaction similarly
  };
}
```

`assertContainsWorkspaceScope(sql)` is a lint-at-runtime check that confirms the SQL either:
- Touches only tables without `workspace_id` (users, sessions, workspaces, workspace_members), OR
- Includes `workspace_id = $` or `wS.workspace_id = $` in WHERE clauses

Violations throw in dev, log warning in prod (graceful degradation during rollout).

### Option B — Postgres Row-Level Security (future, Phase H)

```sql
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON campaigns
  USING (workspace_id = current_setting('app.current_workspace')::text);
```

Then `SET app.current_workspace = 'ws_xxx'` at connection-start. This is the gold standard — defense-in-depth even against buggy app code. Phase A uses option A; we can upgrade to RLS in H without a rewrite.

### Option C — ORM-level scope (rejected)

We don't use an ORM. Keep raw SQL, add helpers.

---

## 5. Request routing

### 5.1 How the server knows which workspace

Three sources, checked in this order:

1. **URL path**: `/api/v2/workspaces/:wsId/campaigns` — most explicit, best for REST
2. **Header**: `X-Workspace-Id: ws_xxx` — used for agent-runtime SSE and WebSocket streams
3. **Session default**: user has a "current workspace" stored on the session; used by the dashboard as a fallback

### 5.2 Middleware

```javascript
// server/workspace-middleware.js

async function workspaceContext(req, res, next) {
  const wsId =
    req.params.workspaceId ||
    req.headers['x-workspace-id'] ||
    req.user?.currentWorkspaceId;

  if (!wsId) return res.status(400).json({ error: 'Workspace context required' });

  // Verify user is a member
  const member = await queryOne(
    'SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?',
    [wsId, req.user.id]
  );
  if (!member) return res.status(403).json({ error: 'Not a member of this workspace' });

  req.workspace = { id: wsId };
  req.workspaceRole = member.role;
  next();
}
```

RBAC middleware updates to read from `req.workspaceRole` instead of `req.user.role`.

### 5.3 What the old /api/v1 endpoints do

They keep working (no breaking change), but always resolve to **the user's first workspace**. Legacy clients see a single-workspace world. New clients use v2 with explicit workspace IDs.

---

## 6. UI changes

### 6.1 Workspace switcher

Top of sidebar, above the logo. Shows current workspace name + down-caret; click opens dropdown of all user's workspaces + "Create new workspace" + "Invite teammates."

```
┌─────────────────────┐
│  [▼] Hakko AI    ⚙  │  ← click opens switcher
├─────────────────────┤
│   Pipeline          │
│   Campaigns         │
│   ...               │
```

Switching workspace = hard refresh to guarantee client state doesn't leak between tenants. Simple and safe.

### 6.2 Current-workspace in URL

Option 1: `influencexes.com/w/{slug}/pipeline` (path-based)
Option 2: `{slug}.influencexes.com/pipeline` (subdomain-based, later)

**Phase A ships option 1** (no DNS work). Subdomains in Phase H when we add white-label.

### 6.3 New pages

- `/settings/workspace` — name, logo, billing, delete
- `/settings/workspace/members` — invite, change role, remove
- `/settings/workspace/plan` — upgrade, billing history (Phase H)
- `/workspaces/new` — create a new one

### 6.4 Non-workspace pages

- `/settings/account` — user profile, email, password, 2FA
- `/settings/notifications` — per-user email prefs

---

## 7. Billing & plan limits

Per-workspace plan with enforced limits:

| Resource | Free (self-host) | Starter | Growth | Scale |
|---|---|---|---|---|
| Workspaces/user | unlimited | 1 | 3 | 10 |
| Members/workspace | unlimited | 2 | 10 | unlimited |
| Agent tokens/month | unlimited | 5K | 50K | 500K |
| Content pieces/month | unlimited | 30 | 300 | unlimited |
| Scheduled posts/month | unlimited | 30 | 300 | unlimited |

Enforcement: a `plan_limits` module that each Agent / publish / contact-send path consults before acting. Exceeding a limit returns `402 Payment Required` with upgrade URL.

Phase A ships the limit-check scaffolding; actual billing integration (Stripe) waits for Phase H.

---

## 8. Testing strategy

New test categories required in Phase A:

1. **Isolation tests** — create two workspaces, insert data in each, verify queries from one never see the other. Run on every PR.
2. **Scope-violation tests** — try to access another workspace's resource via API; expect 403 / 404.
3. **Migration idempotency** — run migration twice on a DB with existing data, verify second run is a no-op.
4. **Backfill correctness** — existing oratis data must end up in exactly one workspace; no lost rows.

Suggested file: `server/__tests__/multitenancy.test.js`.

---

## 9. Concrete week-1 plan

Aligned with ROADMAP Phase A week 1:

- [ ] **Day 1** — Schema migration (workspaces, workspace_members, add columns to 20 tables, backfill)
- [ ] **Day 2** — `scoped()` query helper + `assertContainsWorkspaceScope` checker; update `rbac.js` to read `req.workspaceRole`; `workspace-middleware.js`
- [ ] **Day 3** — API v2 routes under `/api/v2/workspaces/:wsId/*`; audit existing handlers, add workspace_id to all their SQL
- [ ] **Day 4** — Workspace switcher UI, `/settings/workspace`, `/settings/workspace/members`, `/workspaces/new`
- [ ] **Day 5** — Isolation tests, migration tests, fix whatever red tests uncover; deploy to staging; sanity-check with a second test workspace

End of week: Any user can create a workspace, invite a teammate with a specific role, and have complete data isolation from other workspaces.

---

## 10. Things to watch out for

- **Seed script (`server/seed-demo.js`)** — currently creates data without a workspace. Update to create a "Demo Workspace" first.
- **Inbound email webhook** — when a reply comes in, match to `(workspace, contact)` pair, not just contact. Resend doesn't know about our workspaces; we match via the pipeline_job's workspace_id.
- **CSV exports** — scope to current workspace only (obvious, easy to forget).
- **Queue jobs** — every enqueued job must carry its `workspace_id` in the payload; workers resolve the scope from that.
- **Cache keys** — include workspace_id as prefix to avoid leakage.
- **Notification webhooks** — include workspace name + ID in payload so Slack/Feishu users know which workspace fired the event.
- **Rate-limit keys** — currently IP-based; add workspace_id dimension so a noisy workspace can be throttled independently.
- **Self-host users** — if they had v0.8 running with one logical "company," they'll see it as "Legacy" workspace post-upgrade. Give them a one-click rename in `/settings/workspace`.

---

*Last updated: 2026-04-18. Living document — amend as we learn.*
