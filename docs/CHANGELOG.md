# Changelog

> User-facing release notes for InfluenceX. Each entry corresponds to a Cloud
> Run revision shipped to https://influencexes.com/.
>
> **Format**: each release is `## YYYY-MM-DD — codename` followed by grouped
> bullets under `### Added / Changed / Fixed / Removed`. The server parser
> in [server/changelog.js](../server/changelog.js) reads this file and
> exposes it via `GET /api/changelog`. The frontend renders it on the
> `/changelog` page and shows a "New" badge in the sidebar when the latest
> entry is newer than what the user has seen.
>
> **Update this file before every prod deploy.** `deploy.sh` will remind you.

---

## 2026-04-28 — KOL scrape recovery

### Fixed
- **KOL scrape regression**: `scrapeAndEnrichKol` was referencing an undefined `req` after the Apify integration, throwing `ReferenceError` for every KOL added via URL. Existing rows had `scrape_status='error'` and the API status indicator at the top of the KOL Database page showed all-red even when Apify was configured. Both are fixed: scrapes succeed via Apify when MODASH_API_KEY is unset, and the status indicator now reflects Apify availability.

### Added
- **Per-row "Retry scrape" button** on every KOL row in error / partial state — uses the currently-configured API keys.
- **"Retry all failed" bulk button** at the top of KOL Database — re-queues every error/partial row in the workspace (capped at 200, 1s spacer between kicks).
- **`POST /api/kol-database/:id/retry-scrape`** + **`POST /api/kol-database/retry-all`** endpoints, both workspace-scoped.

### Changed
- API status indicator now considers Apify alongside Modash. Tooltip shows which provider is serving each platform (e.g. "instagram via apify" vs "instagram via modash").

---

## 2026-04-28 — Changelog system

### Added
- **/changelog page**: every release shipped to prod is now visible to all users with a "What's new" badge in the sidebar when there are unread entries.
- **Server endpoint** `GET /api/changelog`: parses [docs/CHANGELOG.md](docs/CHANGELOG.md) and returns structured entries — public (no auth) so anyone landing on the site can read release notes.
- **Cmd-K palette** gets a "View changelog" jump.

---

## 2026-04-27 — Apify auto-discovery + cross-entity search

### Added
- **Inbox auto-discovery**: when a workspace has connected Instagram or TikTok via OAuth, the hourly inbox-sync cron now auto-pulls comments from the workspace's own recent posts. No more pasting URLs.
- **Cmd-K command palette** (Ctrl+K on Windows/Linux) searches across pages, KOLs, Contacts, and Campaigns — fuzzy match with keyboard navigation.
- **Reviews → review-miner one-click**: the Reviews dashboard's summary block has a "Run review-miner" button that hands off to the agent with the source pre-filled.
- **Onboarding tour replay**: user menu has a "Replay tour" entry to re-watch the 5-step intro.

### Changed
- AgentsPage now accepts deep-links via `/#/agents?run=<id>&input=<json>` so other pages can hand off pre-filled work.

---

## 2026-04-27 — Observability infrastructure

### Added
- **Sentry error tracking** (Sprint A1): server + client SDKs gated on `SENTRY_DSN` / `VITE_SENTRY_DSN`. Captures unhandled exceptions, attaches `workspace_id` tag and authenticated user. PII-safe (email/id only).
- **OpenTelemetry tracing** (Sprint A2): auto-instruments HTTP, Express, pg, fetch. Gated on `OTEL_EXPORTER_OTLP_ENDPOINT` so unset = no-op.
- **BullMQ + Redis queue** (Sprint A3+A4): scaffolding ready — flip a single env (`REDIS_URL`) to migrate from in-process queue to Redis-backed, enabling multi-instance Cloud Run.

### Changed
- Bootstrap admin from `ADMIN_EMAIL` env now actually promotes the user to `role='admin'` (was previously a latent bug — user got created but stayed as a regular member).

---

## 2026-04-27 — Reviews + Discovery UI

### Added
- **Reviews dashboard** (`/reviews`): pulls reviews from Steam / App Store / Play Store, classifies sentiment (positive / neutral / negative), shows summary cards + reviews table.
- **Discovery page** (`/discovery`): unified UI for YouTube / Instagram / TikTok / X / Reddit creator discovery. Multi-platform picker, keyword search, real-time job polling, results table.
- **Discovery actions**:
  - **Add selected to campaign** — bulk-imports chosen creators into the active campaign and queues outreach pipeline
  - **Save to KOL Database** — alternative path that stashes candidates without sending emails
  - **Export CSV** — one-click download of the full candidate list
- **Apify Runs admin page** (`/apify-runs`): for platform admins. Lists actor invocations with status filters + reap-stuck-runs button.

### Changed
- Inbox `Sync from Apify` modal — pull comments from any Instagram or TikTok URL into the unified inbox, dedup by external ID.

---

## 2026-04-27 — Apify integration foundation

### Added
- **Multi-platform discovery** (Apify Phase B): Instagram + TikTok + X + Reddit on top of the existing YouTube discovery. Each platform has rule-based scoring + per-workspace daily quota.
- **Profile cache layer**: scraping the same KOL within 7 days now hits the cache, skipping paid Apify calls.
- **Per-workspace cost cap**: a single workspace can no longer drain platform-wide Apify budget. Configurable via `APIFY_WORKSPACE_DAILY_RUN_QUOTA` + `APIFY_WORKSPACE_DAILY_ITEMS_QUOTA`.
- **Failure watchdog**: stuck Apify runs older than 60 minutes get auto-marked `timeout` so they don't pollute quota / status views.
- **Webhook receiver** at `POST /api/webhooks/apify` for async actor mode (skeleton, ready when individual actors switch to async).
- **Actor registry** (`server/apify-actors/`): adding a new Apify actor = drop a single file with `buildInput` + `normalize` functions.

### Changed
- `scraper.js` for Instagram / TikTok now uses Apify when MODASH_API_KEY is unset — no more "MODASH required" errors when only Apify is configured.

---

## 2026-04-27 — Invite codes & onboarding UX

### Added
- **Invite-code registration**: platform admins generate sharable codes (`INFLX-XXXXXXXX`) that anyone can use to register at `/signup`. Multi-use, optional expiry, optional revocation. Distinct from the per-email invitation links — those still work.
- **Forgot-password flow**: standard email + reset-link path with one-time, 1-hour, sha256-hashed tokens. The endpoint always returns 200 (regardless of whether the email exists) to prevent account enumeration.
- **5-step onboarding tour** auto-shows for first-time users with no campaigns. Each step has an optional CTA that dismisses + deep-links to the relevant page.
- **Mobile responsive layout**: <600px viewport collapses the sidebar into a slide-in drawer with hamburger toggle.
- **Smart post-login redirect**: zero campaigns → Conductor (best place to bootstrap a plan); otherwise → Pipeline.
- **Password show/hide toggle** on every auth form.

### Changed
- Login page: "Sign up with invite code" is now a full-width secondary button, not a small link.
- Server auto-creates a default workspace for users who somehow end up without one (orphaned account, deleted workspace) — no more "Workspace context required" dead-end.

---

## How this file is updated

When you ship a new revision via `./deploy.sh`:

1. Pick a date (most recent at the top) and an optional codename
2. Group changes under **Added / Changed / Fixed / Removed**
3. Write user-facing prose, not commit hashes — readers should understand what changed without git context
4. Push the doc commit alongside the feature commits, OR as a follow-up commit before deploy

The server reads this file at startup and on each `/api/changelog` request (cached 60s in-process). Frontend renders it on `/changelog`.
