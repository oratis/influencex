# Contributing to InfluenceX

Thanks for your interest in contributing. This guide covers the practical bits — code layout, test expectations, and how to submit changes.

## Quick start (local dev)

**With Docker Compose** (recommended — runs Postgres + app together):

```bash
git clone https://github.com/oratis/influencex.git
cd influencex
cp .env.example .env     # fill in keys you have
docker compose up -d
# → http://localhost:8080/InfluenceX
```

**Without Docker** (uses SQLite, no external deps):

```bash
git clone https://github.com/oratis/influencex.git
cd influencex
npm install
cd client && npm install && cd ..
npm run build
npm start
```

## Project layout

```
server/
  index.js                  Express app, all route handlers
  database.js               Unified PG + SQLite interface
  auth.js                   Session + bcrypt + login rate limit
  rbac.js                   Role-based permission system
  scraper.js                Multi-platform KOL scraping
  agents/
    mail-agent.js           Resend + nodemailer email sending
    discovery-agent.js      YouTube channel discovery
    data-agent.js           Content stats scraping
  job-queue.js              In-process queue (retry/backoff/concurrency)
  cache.js                  TTL cache with LRU eviction
  scheduler.js              Background email scheduler
  notifications.js          Slack/Feishu/Discord webhook fanout
  csv-export.js             RFC 4180 CSV generation
  email-templates.js        Template rendering with {{variables}}
  youtube-quota.js          YouTube API quota tracker
  openapi.js                OpenAPI 3.1 spec + Swagger UI
  migrations.js             Forward-only schema migrations
  roi-dashboard.js          Campaign ROI aggregation
  rate-limit.js             Sliding-window rate limiter
  health.js                 /healthz, /readyz, /metrics
  apify-client.js           Instagram/TikTok via Apify
  __tests__/                Node built-in test runner
client/
  src/pages/                Top-level routed pages
  src/components/           Shared UI (Toast, ConfirmDialog, ...)
  src/api/client.js         Typed fetch wrapper
  src/i18n.jsx              i18n context + messages
```

## Running tests

All server modules have a unit test or are planned to. Tests use the Node built-in test runner — no Jest, Mocha, etc.

```bash
npm test              # one-shot
npm run test:watch    # re-run on save
```

Before sending a PR, make sure `npm test` and `npx vite build` (in `client/`) both pass. The CI pipeline will fail the PR otherwise.

## Writing a new endpoint

Append to `server/index.js`. Prefer short handlers that call into a module:

```javascript
app.post(`${BASE_PATH}/api/something`, authMiddleware, rbac.requirePermission('kol.update'), async (req, res) => {
  try {
    const result = await someModule.doThing(req.body, { query, exec });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

Also add the endpoint to `server/openapi.js` and a client binding in `client/src/api/client.js` so the UI can call it.

## Writing a new migration

Append an entry to the `MIGRATIONS` array in `server/migrations.js`. Migrations are forward-only — if you need to undo something, add a new migration.

```javascript
{
  id: '2026-05-15-add-kol-tags',
  description: 'Add tags column to kols',
  up: async ({ exec }) => {
    try { await exec('ALTER TABLE kols ADD COLUMN tags TEXT DEFAULT "[]"'); }
    catch (e) { if (!/duplicate|already exists/i.test(e.message)) throw e; }
  },
},
```

## Code style

- **Comments explain why, not what.** Code should be clear enough to show what.
- **No emojis in source code** unless the user explicitly asks for them in UI strings.
- **Use existing patterns.** New pages should use the Toast/ConfirmDialog hooks, not `alert()`.
- **Errors bubble up.** Handlers catch and return 500 with `{ error: msg }` — modules throw.
- **No new dependencies without discussion.** We prefer Node built-ins and already-in-project libs.

## Security

If you find a security issue, please open a private security advisory on GitHub instead of a public issue. Do not include exploit details in public discussion.

## License

By submitting a PR, you agree your contribution is licensed under the same MIT license as the project.
