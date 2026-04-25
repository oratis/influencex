# InfluenceX — Claude Code Context

@docs/design.md — 设计系统单一权威：颜色 / 排版 / 间距 / 圆角 / 组件 / 页面布局 / a11y / 反模式。Token 数值住在 `client/src/index.css` 的 `:root`，本文档只讲怎么用。
@docs/memory.md — 项目记忆库：架构决策、历史包袱、生产环境关键事实、常见陷阱。新会话开工前**先扫一遍**避免重新踩坑。
- `docs/ROADMAP.md` — 长期愿景（8 阶段 A→H）。仅在做战略决策时按需读
- `docs/ROADMAP_2026-Q2.md` — 当前 Sprint 切片（6 周计划，4 大支柱）。日常按这份执行
- `docs/STATUS_AND_GAPS.md` — 历史状态盘点（2026-04-22 后已冻结，仅供回看）
- `docs/PLATFORM_AUDIT_2026-04.md` — 用户视角 UX 审计（修复进度见 ROADMAP_2026-Q2 §1）
- `docs/KOL_FLOW_TEST_2026-04.md` — KOL 链路 E2E 测试报告（11/12 已修，剩 Hunter 扩展）
- `docs/MULTITENANCY.md` — 多租户架构契约。新增 API 端点必读
- `docs/USER_GUIDE.md` — 终端用户操作手册

> This file provides context for Claude Code sessions working on this project.

## Project Overview

InfluenceX (https://influencexes.com) is an **invite-only AI marketing platform** for SMBs. Brands invite team members; the platform runs creator discovery, KOL outreach, content generation, scheduled publishing, and ROI tracking — orchestrated by a swarm of LLM agents.

**Positioning**: "Your content marketing runs itself while you sleep."

**Repo**: https://github.com/oratis/influencex (MIT, single repo, no monorepo)

## Repo Layout

- `server/` — Express 5 API, single process, ~30 modules
- `server/agents-v2/` — 18 LLM agents (strategy, research, content-text/visual/voice/video, kol-outreach, publisher, ads, community, etc.)
- `server/agent-runtime/` — agent registry + Conductor (goal → plan → run)
- `server/llm/` — Anthropic + OpenAI + Gemini + 火山方舟 routing layer with cache + cost stats
- `server/__tests__/` — 234 Node test runner unit tests (no frontend tests yet)
- `client/` — Vite + React 18 SPA (HashRouter); `client/src/pages/*.jsx` is one page per route
- `docs/` — see file links above
- `deploy.sh` / `migrate-env-to-secret.sh` / `setup-secrets.sh` — Cloud Run + Secret Manager helpers
- `.claude/launch.json` — `preview_start` configs for local dev (server: 8080, client: 5173)

Package manager: **npm**. No workspaces. Server deps and client deps live in two `package.json` files.

## Key Technologies

- **Express 5** — single API service, serves static client/dist + JSON API
- **better-sqlite3 (local) / pg (prod)** — dual DB driver, switch via `DATABASE_URL.startsWith('postgresql://')`
- **better-sqlite3** for `npm test` and local; **Postgres 15 on Cloud SQL** for prod (instance `gameclaw-492005:us-central1:influencex-db`)
- **No ORM** — raw SQL via `query()` / `queryOne()` / `exec()` / `transaction()` from `server/database.js`. The `scoped()` helper enforces workspace_id in every query
- **Vite 5 + React 18 + react-router-dom v6 (HashRouter)** — frontend; lazy imports for heavy pages (RoiDashboard, DataModule)
- **In-process job queue** (`server/job-queue.js`) — being migrated to BullMQ in Sprint 1
- **In-process cache + rate limit** — same migration target
- **Resend** for email send; **Gmail OAuth** as alt sender per workspace
- **i18n**: hand-rolled `client/src/i18n.jsx` with EN + ZH dicts, `t(key, vars)` API

## API Architecture

```
client (HashRouter, Vite SPA)
  ↓ /api/* (proxied through same origin in prod)
Express
  ↓ workspaceContext (lenient default fallback)
  ↓ rate-limit (sliding window in-memory)
  ↓ route handler
  ↓ scoped(req.workspace.id).query(...)  ← enforces tenant isolation in SQL
  ↓ JSON response
```

- **All `/api/*` routes** auto-resolve workspace via `X-Workspace-Id` header → `req.user.currentWorkspaceId` → user's first workspace. Skip list in `WORKSPACE_SKIP_PREFIXES` (auth, webhooks, OAuth callbacks)
- **Background jobs** (`server/job-queue.js` + handlers in `server/email-jobs.js`, `server/scheduled-publish.js`, `server/scheduler.js`)
- **Job queue worker registers handlers**: `email.send`, `email.batch_send`, `email.sync_status`, scheduler internal types
- **Stage transitions** (Pipeline): `scrape → write → review → send → monitor` — write-stage creates a `contacts` row; approve queues `email.send`; worker syncs `pipeline_jobs.stage` back from contact state

## Critical Rules

### Invite-Only — No Public Registration
`POST /api/auth/register` returns **410 Gone** (`code: REGISTRATION_DISABLED`). New accounts only via `POST /api/invitations/:token/accept`. The `registerUser()` internal function is still used by the admin-bootstrap path and `/api/users/invite`.

### Workspace Isolation Is The Floor
Every `/api/*` route except those in `WORKSPACE_SKIP_PREFIXES` (auth, webhooks, OAuth callbacks) auto-attaches `req.workspace.id`. **Always**:
1. SELECT WHERE `workspace_id = ?` (use `scoped(req.workspace.id).query(...)` for ergonomics)
2. INSERT with `workspace_id` set explicitly
3. Cross-table joins must include the workspace check on every joined row

This is the floor — see [docs/MULTITENANCY.md](docs/MULTITENANCY.md) for contract.

### Stripe / Billing Is Removed
There is no payment flow. `server/billing.js` was deleted in commit `bccfdde`. The `subscriptions` table exists from a prior migration but is not queried. All features are free for invited users. Don't reintroduce payment without an explicit product decision.

### Always Pass `workspaceId` to `runPipeline`
`runPipeline(jobId, profileUrl, platform, username, campaignId, workspaceId)` — the last param is required. Discovery → process used to forget it; was fixed in `7c825d7`. New callers must pass it.

### Email Send Goes Through The Queue
Both `/api/contacts/:id/send` (Contact module) and `/api/pipeline/jobs/:id/approve` (Pipeline) push into the same `email.send` job queue. The worker (`server/email-jobs.js`) is the single source of truth: it updates `contacts.status`, syncs `pipeline_jobs.stage`, writes `email_replies`, records events. **Do not bypass it** with synchronous `mailAgent.sendEmail()` calls.

### Outreach Email Goes Through The LLM
`generateOutreachEmail(kol, campaign, cooperationType, priceQuote)` is now async. It tries `llm.complete()` first (Anthropic / OpenAI / Gemini / 火山方舟 — whichever has a key), falls back to template silently. **All 5 callers must `await`** — see commit `44324f9`. Don't reintroduce the sync template-only path.

### Never Source `deploy.sh` to Test Things
Memory: sourcing `deploy.sh` triggers `gcloud builds submit` even if you only wanted to inspect a variable. To peek at vars, extract assignments into a separate script or use `bash -n deploy.sh` for syntax check.

### Production Domain is `influencexes.com` (with the 'es')
NOT `influencex.com`. Don't typo this in copy, env vars, OAuth redirect URIs, or DNS.

## Common Commands

```bash
# Local dev
preview_start influencex          # server on :8080 (SQLite if no DATABASE_URL)
preview_start influencex-client   # Vite dev on :5173 (HMR)

# Tests (server only — no frontend tests yet)
npm test                          # 234 unit tests, ~3s

# Build client
cd client && npx vite build       # outputs client/dist/

# Deploy to prod (build + push image + Cloud Run deploy)
./deploy.sh                       # blocking ~5 min; uses .env for Secret Manager refs

# One-time prod env→secret migration (already done; idempotent re-run safe)
./migrate-env-to-secret.sh

# Bootstrap secrets from .env into GCP Secret Manager
./setup-secrets.sh

# Connect to prod Postgres via Cloud SQL Auth Proxy (read-only investigation)
cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db &
# password is in .env DATABASE_URL (postgres user)
node -e "const {Client}=require('pg');..."   # one-off queries
```

## File Locations — Quick Reference

| What | Where |
|---|---|
| Express app entry | `server/index.js` (~5100 lines, monolithic) |
| Database driver dispatch | `server/database.js` (`usePostgres = DATABASE_URL.startsWith('postgresql://')`) |
| Migrations | `server/migrations.js` (forward-only, tracked in `schema_migrations` table) |
| Auth (session + JWT) | `server/auth.js` |
| Workspace middleware | `server/workspace-middleware.js` (lenient global mounted at `/api/*`) |
| RBAC | `server/rbac.js` (admin / editor / viewer + permission strings) |
| LLM routing | `server/llm/index.js` (4 providers, cache, cost stats) |
| Job queue + workers | `server/job-queue.js` + `server/email-jobs.js` + `server/scheduled-publish.js` + `server/scheduler.js` |
| Email send (mailbox-aware) | `server/email.js` (signature: `{ to, subject, body, fromName, mailboxAccount, onCredsRefreshed }`) |
| Outreach email gen (LLM) | `server/index.js:5305` `async function generateOutreachEmail()` |
| Pipeline orchestrator | `server/index.js:4303` `async function runPipeline()` |
| Conductor (goal → plan) | `server/agent-runtime/conductor.js` |
| Agent registry | `server/agent-runtime/index.js` |
| Agents | `server/agents-v2/*.js` (one file per agent) |
| Resend webhook | `POST /api/webhooks/resend/events` |
| Invite acceptance flow | `POST /api/invitations`, `GET /api/invitations/:token`, `POST /api/invitations/:token/accept` |
| Client routes | `client/src/App.jsx` (`<Routes>` for both auth'd + public) |
| Pages | `client/src/pages/*.jsx` (21 pages) |
| Reusable components | `client/src/components/*.jsx` (ErrorBoundary, ErrorCard, ContactThreadDrawer, TemplateManagerDrawer, etc.) |
| API client | `client/src/api/client.js` (request wrapper + `toastApiError` helper) |
| i18n dictionaries | `client/src/i18n.jsx` (EN + ZH inline) |
| Vite config | `client/vite.config.js` |
| GCP Cloud Build | `deploy.sh` (no `cloudbuild.yaml`; we use `gcloud builds submit --tag`) |
| Dockerfile | `Dockerfile` (root, single-stage, runs `node server/index.js`) |
| Env example | `.env.example` |

## Environment Variables

See `.env.example` for the full template. **All sensitive values live in GCP Secret Manager** (project `gameclaw-492005`); the local `.env` is only used by `setup-secrets.sh` to bootstrap them.

**Critical to set** (will fail-fast if missing in prod):
- `MAILBOX_ENCRYPTION_KEY` — 32-byte base64; encrypts `mailbox_accounts.credentials_encrypted`
- `DATABASE_URL` — Postgres connection string with embedded password
- `RESEND_API_KEY` — primary email sender
- `ANTHROPIC_API_KEY` — primary LLM (or set `OPENAI_API_KEY` / `GOOGLE_AI_API_KEY` as alternative; `llm/index.js` auto-picks)

**Important non-secret env** (set via `deploy.sh --update-env-vars`):
- `CORS_ORIGINS` — comma-separated; `^##^` delimiter trick handles embedded commas
- `OAUTH_CALLBACK_BASE` — must match Google Cloud Console OAuth redirect URIs
- `LLM_DEFAULT_PROVIDER` (`anthropic` / `openai` / `google`) — currently `anthropic`

## Deployment

- **Platform:** GCP Cloud Run (us-central1), project `gameclaw-492005`
- **Service:** `influencex` (single service), domain `https://influencexes.com/` (Cloudflare DNS → Cloud Run)
- **CI/CD:** none yet — deploy is manual via `./deploy.sh`. Build + push GCR image + `gcloud run deploy`
- **Database:** Cloud SQL Postgres 15 (`gameclaw-492005:us-central1:influencex-db`). Connection via Cloud SQL Auth Proxy + Unix socket on Cloud Run
- **Secrets:** GCP Secret Manager, 36 secrets bound via `--update-secrets` in deploy.sh
- **Latest revision:** check `gcloud run services describe influencex --region=us-central1 --format='value(status.traffic[0].revisionName)'`

### Production Release Log

Each prod deploy increments the Cloud Run revision number (`influencex-NNNNN-xxx`). No formal CHANGELOG yet — git log is the source of truth. After Sprint 3 we'll start `docs/CHANGELOG.md`.

## Debugging Production

- **Cloud Run logs:** `gcloud run services logs read influencex --region=us-central1 --limit=50`
- **Postgres queries:** start `cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db` then connect with any pg client. Password is in `.env` DATABASE_URL
- **No Sentry yet** — Sprint 1 task A1. Until then, ErrorBoundary just `console.error`s
- **No OpenTelemetry yet** — Sprint 1 task A2

## Known Issues / Gotchas

See [docs/memory.md](docs/memory.md) for the full list. Highlights:

- **Invitation conflict on already-registered emails**: `/api/invitations/:token/accept` returns 409 `EMAIL_EXISTS`. UI surfaces "log in instead" link.
- **`hakko-q1-all` is a legacy demo campaign**: server seeds it on first boot. Don't use as a fallback in new code — use `defaultCampaignForWorkspace()` instead.
- **Pipeline ↔ Contact dual flow**: solved by `pipeline_jobs.contact_id` link + worker reverse-sync. UI shows the same row from both pages.
- **Hunter.io fallback** only works for KOLs with a linked website on their channel page. No-website KOLs need a paid Hunter Email-Finder plan + known domain.
- **Frontend has no tests** — Sprint 2 task C1+C2 will add Playwright + Vitest. Until then, manual smoke after every feature.
- **`subscriptions` table is dormant** — left from removed Stripe billing. Don't query.

## Session Safety

- **Never `git push --force` to main** without explicit user approval
- **Never run `./deploy.sh` to "test something"** — it deploys real revisions
- **Never edit `.env`** without restoring it after; `.env` contains real prod secrets
- **`gcloud run services update --remove-env-vars=...`** triggers a new revision; if the revision fails to start, traffic stays on previous revision (safe), but accumulates failed revisions
- **Don't write to prod Postgres without confirming** — use Cloud SQL Auth Proxy + read-only queries first
