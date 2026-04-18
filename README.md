# InfluenceX

[![CI](https://github.com/oratis/influencex/actions/workflows/ci.yml/badge.svg)](https://github.com/oratis/influencex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![Tests: 65](https://img.shields.io/badge/tests-65%20passing-brightgreen)](./server/__tests__)
[![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1-blue)](./server/openapi.js)

An open-source KOL (Key Opinion Leader) marketing automation platform. Discover creators on YouTube, TikTok, and Instagram; run outreach pipelines; track campaign ROI — all in one self-hostable app.

> **One command to try it:** `docker compose up -d` → `npm run seed` → open `http://localhost:8080/InfluenceX` → log in as `demo@influencex.dev` / `demo1234`

## Features

- **Multi-platform KOL discovery** — YouTube Data API, TikTok, Instagram (via Apify), Twitch
- **Smart email discovery** — Regex → bio-link services (Linktree, Beacons) → personal website scrape → Hunter.io domain search
- **Outreach pipeline** — Draft → review → approve → send via Resend, with inbound webhook to capture replies
- **ROI dashboard** — Conversion funnel, reply/contract/completion rates, effective CPM, cost-per-outcome
- **Campaign management** — Organize KOLs into campaigns, track contract → content → payment workflow
- **Analytics** — Feishu sheet sync, GA4 website metrics, daily content stats trending
- **Background automation** — Scheduled email sends, auto follow-ups, batch KOL discovery, quota-aware YouTube calls
- **Multi-user** — Admin / Editor / Viewer RBAC, invite flow, i18n (en/zh)
- **Production-grade** — Rate limiting, CORS whitelist, login lockout, health checks, ETag caching, gzip, CSV export, webhook notifications (Slack / Feishu / Discord)

## Architecture

```
                    ┌──────────────────────────────────┐
                    │         React SPA (Vite)         │
                    │  Pipeline / Campaigns / ROI /    │
                    │  KOL DB / Contacts / Data / ...  │
                    └─────────────┬────────────────────┘
                                  │ /InfluenceX/api/*
                                  ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                  Express app (server/index.js)              │
    │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
    │  │   auth    │  │  rbac     │  │rate-limit │  │  health   │ │
    │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
    │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
    │  │  scraper  │  │ discovery │  │mail-agent │  │ scheduler │ │
    │  │ (YT/TT/IG)│  │  (YouTube)│  │  (Resend) │  │(follow-up)│ │
    │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
    │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
    │  │job-queue  │  │  cache    │  │   roi     │  │notifications│
    │  │ (retry/   │  │ (TTL/LRU) │  │dashboard  │  │(Slack/Fei/ │ │
    │  │  backoff) │  │           │  │           │  │  Discord)  │ │
    │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
    │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
    │  │  openapi  │  │migrations │  │email-tpl  │  │ yt-quota  │ │
    │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
    └─────────────────────────┬───────────────────────────────────┘
                              │
      ┌───────────────────────┼───────────────────────────────┐
      ▼                       ▼                               ▼
 ┌──────────┐        ┌──────────────────┐            ┌──────────────┐
 │PostgreSQL│        │ External APIs    │            │  Webhooks    │
 │ or       │        │ • YouTube        │            │ • Resend     │
 │ SQLite   │        │ • Hunter.io      │            │   inbound    │
 │          │        │ • Resend/SMTP    │            │              │
 │          │        │ • GA4 / Feishu   │            │              │
 │          │        │ • Apify (IG/TT)  │            │              │
 └──────────┘        └──────────────────┘            └──────────────┘
```

## Quick start

### Docker Compose (fastest)

```bash
git clone https://github.com/oratis/influencex.git
cd influencex
cp .env.example .env          # optional: fill in API keys
docker compose up -d
docker compose exec app npm run seed    # sample data
```

Open **http://localhost:8080/InfluenceX** and log in as `demo@influencex.dev` / `demo1234`.

### Manual (local Node)

```bash
git clone https://github.com/oratis/influencex.git
cd influencex
npm install
cd client && npm install && cd ..
npm run build
npm run seed       # optional sample data
npm start
```

Uses SQLite by default — no external DB required.

## Configuration

Set environment variables (or copy `.env.example` to `.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (omit to use SQLite) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Auto-create admin on first boot |
| `YOUTUBE_API_KEY` | YouTube Data API v3 |
| `RESEND_API_KEY` | Email sending |
| `RESEND_FROM_EMAIL` / `RESEND_REPLY_TO` | Sender/reply-to addresses |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret for inbound webhook |
| `HUNTER_API_KEY` | Hunter.io domain search |
| `APIFY_TOKEN` | Instagram/TikTok scraping via Apify |
| `GA4_PROPERTY_ID` / `GOOGLE_APPLICATION_CREDENTIALS` | Website analytics |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu sheet sync |
| `NOTIFY_SLACK_WEBHOOK_URL` | Slack notifications |
| `NOTIFY_FEISHU_WEBHOOK_URL` | Feishu bot notifications |
| `NOTIFY_DISCORD_WEBHOOK_URL` | Discord notifications |
| `CORS_ORIGINS` | Comma-separated list, production only |
| `SCHEDULER_ENABLED` | Set `false` to disable background email scheduler |

See [.env.example](./.env.example) for the full list.

## API documentation

Live Swagger UI at **http://localhost:8080/InfluenceX/api/docs** after starting the server.
Raw OpenAPI 3.1 spec at `/api/openapi.json`.

## Deployment

### Google Cloud Run

```bash
./deploy.sh      # builds, pushes, deploys
```

Uses Cloud SQL via `--add-cloudsql-instances` — the app connects over Unix socket when `K_SERVICE` is set.

### Any Docker host

```bash
docker build -t influencex .
docker run -p 8080:8080 --env-file .env influencex
```

## Tech stack

- **Backend:** Node.js 18+, Express 5, PostgreSQL 15 or SQLite
- **Frontend:** React 18, Vite, Recharts (lazy-loaded)
- **Email:** Resend (with SMTP fallback via nodemailer)
- **External:** YouTube Data API, Hunter.io, Apify, GA4, Feishu Open Platform
- **Tests:** Node built-in test runner, GitHub Actions CI

## Project status

Seven phases delivered (see [CHANGELOG](./CHANGELOG.md) for details):

1. **Security** — hardcoded-secret removal, CORS whitelist, login lockout, rate limiting
2. **UI polish** — Toast/ConfirmDialog, 404 page, error-state normalization
3. **Core** — real email sending, real KOL collection, YouTube quota tracking, DB migrations, email templates
4. **Advanced** — CSV export, RBAC, webhook notifications, email scheduler
5. **Production** — 65 unit tests, CI pipeline, rate limiting, health endpoints, ROI backend, code splitting
6. **Frontend** — ROI dashboard, i18n (en/zh), user management, OpenAPI docs
7. **Scale** — job queue, TTL cache, Apify integration, Docker Compose, community docs

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and PRs are welcome.

## License

[MIT](./LICENSE) © 2026 InfluenceX Contributors
