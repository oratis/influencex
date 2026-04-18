# Changelog

All notable changes to InfluenceX. Format: [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- **Phase 8:** gzip compression middleware (skips CSV exports)
- **Phase 8:** Long-term cache headers for hashed Vite assets (`max-age=31536000, immutable`)
- **Phase 8:** DB query timing instrumentation with slow-query log
- **Phase 8:** `GET /api/query/stats` endpoint (admin-only)
- README badges + ASCII architecture diagram

## [0.7.0] — Phase 7: Scale & Community

### Added
- In-process job queue (`server/job-queue.js`) with concurrency control, exponential backoff retry, pause/resume, events
- TTL cache (`server/cache.js`) with LRU eviction and `remember()` helper
- Apify integration (`server/apify-client.js`) for Instagram/TikTok scraping
- Docker Compose for one-command dev environment
- `npm run seed` — demo data seeder (admin + 2 campaigns + 12 KOLs + drafts)
- CONTRIBUTING.md, bug/feature issue templates, PR template
- 21 new tests (queue + cache) — 65 total
- `GET /api/queue/stats`, `GET /api/cache/stats`, `GET /api/apify/status`

## [0.6.0] — Phase 6: Frontend Completion

### Added
- ROI dashboard page with funnel chart and cost efficiency metrics (lazy-loaded)
- User management admin page (list, invite, change role, delete)
- i18n framework with en/zh, `LanguageSwitcher` in header
- OpenAPI 3.1 spec at `/api/openapi.json`, Swagger UI at `/api/docs`
- User management endpoints: `GET /api/users`, `POST /api/users/invite`, `PATCH /api/users/:id/role`, `DELETE /api/users/:id`

## [0.5.0] — Phase 5: Production Readiness

### Added
- 44 unit tests (csv-export, rbac, email-templates, youtube-quota)
- GitHub Actions CI workflow (Node 18 + 20 matrix)
- Rate limiting middleware applied to auth, discovery, send, export endpoints
- Health endpoints: `/healthz`, `/readyz`, `/metrics`
- ROI dashboard backend module
- Vite code splitting: DataModule lazy-loaded, react+recharts in separate chunks

### Changed
- Initial JS bundle: 713 KB → 91 KB (72% reduction)

## [0.4.0] — Phase 4: Advanced Features

### Added
- CSV export for KOLs / contacts / content data (RFC 4180, UTF-8 BOM)
- Role-based access control with admin / editor / viewer
- Webhook notifications: Slack / Feishu / Discord / generic JSON
- Email scheduler with follow-up reminders
- Schema migration: `scheduled_send_at` + `follow_up_count` on contacts
- Resend inbound webhook fires `email.reply` notification

## [0.3.0] — Phase 3: Core Feature Completion

### Added
- `POST /api/contacts/:id/send` now actually sends email via Resend/SMTP
- Campaign KOL collection uses real YouTube Discovery API when configured
- YouTube daily quota tracker with 10% safety margin
- Forward-only migration framework
- Email template system with `{{variable}}` substitution (4 built-in templates)

### Changed
- AI scoring is now deterministic (removed Math.random jitter)
- Feishu sheet tokens configurable via env vars

## [0.2.0] — Phase 2: UI Experience

### Added
- Shared `Toast` notification component replacing native `alert()`
- `ConfirmDialog` component replacing native `confirm()` and `prompt()`
- 404 NotFoundPage with navigation options
- Global error handling with try/catch + toast on all async handlers

### Fixed
- Broken "Go to Contact" link in CampaignDetail
- `formatNumber` crash on null/undefined
- Analytics tab blank screen when GA4 unavailable
- Empty campaign dropdown

## [0.1.0] — Phase 1: Security Hardening

### Added
- Login rate limiting (5 attempts / 15 min lockout)
- CORS whitelist via `CORS_ORIGINS` env var
- 17 database indexes on high-traffic columns
- Session cleanup job (hourly)
- HTML escape on email bodies before sending

### Fixed
- Removed hardcoded admin password from source
- Removed Math.random from AI scoring (reproducibility)

## [0.0.1] — Initial Release

- Multi-platform KOL scraping (YouTube, TikTok, Twitch + stubs for Instagram/X)
- Campaign management with AI scoring
- Outreach pipeline with email thread tracking
- Resend inbound webhook for reply capture
- Feishu spreadsheet sync + GA4 integration
