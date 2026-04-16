# InfluenceX

An open-source KOL (Key Opinion Leader) marketing automation platform. InfluenceX helps marketing teams discover creators across YouTube, TikTok, and Twitch, manage outreach pipelines, and track campaign performance — all in one place.

## Features

- **Multi-platform KOL discovery** — Search and scrape creator profiles from YouTube, TikTok, and Twitch
- **Enhanced email discovery** — Multi-strategy email extraction: direct regex → bio link services (Linktree, Beacons, etc.) → personal website scraping → Hunter.io domain search
- **Outreach pipeline** — Draft, approve, and send personalized emails via Resend
- **Email thread tracking** — Inbound replies captured via webhook and threaded with outbound messages
- **Campaign management** — Organize KOLs into campaigns, track deliverables and stages
- **Analytics & data module** — Track content performance with daily stats trends, manual data entry, and GA4 integration
- **Feishu sync** — Pull registration and content data from Feishu Spreadsheets
- **Batch discovery** — Background task to harvest active creators with obtainable emails

## Tech Stack

- **Backend:** Node.js, Express, PostgreSQL (Cloud SQL) or SQLite
- **Frontend:** React + Vite
- **Email:** Resend (inbound webhooks via Svix signatures)
- **Data sources:** YouTube Data API, Hunter.io, Google Analytics 4, Feishu Open API
- **Deploy:** Docker, Google Cloud Run

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 15 (optional — falls back to SQLite)
- API keys for the services you want to use

### Installation

```bash
git clone https://github.com/oratis/influencex.git
cd influencex
npm install
cd client && npm install && cd ..
```

### Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required keys depend on which features you use:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (omit to use SQLite) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 |
| `RESEND_API_KEY` | Resend email sending |
| `RESEND_FROM_EMAIL` | Sender address (verified domain) |
| `RESEND_REPLY_TO` | Reply-to address for inbound capture |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret for inbound webhooks |
| `HUNTER_API_KEY` | Hunter.io domain search |
| `GA4_PROPERTY_ID` | GA4 property for analytics |
| `GOOGLE_APPLICATION_CREDENTIALS` | GA4 service account key path |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu Open Platform app |
| `HTTPS_PROXY` / `HTTP_PROXY` | Optional proxy for restricted regions |

### Run

```bash
# Build frontend
npm run build

# Start server
npm start
```

Server runs on `http://localhost:3000` by default.

For development with hot reload on the client:

```bash
npm run dev:client   # in one terminal
npm run dev          # in another
```

## Deployment

A `Dockerfile` and `deploy.sh` script are included for Google Cloud Run. Build for `linux/amd64`:

```bash
docker buildx build --platform linux/amd64 -t influencex .
```

See `deploy.sh` for the full Cloud Run deploy flow (uses `--add-cloudsql-instances` for managed Postgres).

## Project Structure

```
server/
  index.js         # Express app and API routes
  database.js      # PG + SQLite schemas
  scraper.js       # Multi-platform KOL scraping + email discovery
  feishu.js        # Feishu Open API integration
  ga4.js           # Google Analytics 4 integration
  agents/
    mail-agent.js  # Resend email sending
client/
  src/
    pages/         # DataModule, PipelinePage, ContactModule, etc.
    components/
    api/client.js
```

## Contributing

Issues and pull requests are welcome. This project is in active development — expect rough edges.

## License

[MIT](./LICENSE) © 2026 InfluenceX Contributors
