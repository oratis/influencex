# Apify Integration Roadmap

> Comprehensive plan for deepening influenceX's integration with the Apify
> scraping platform — from filling current capability gaps to unlocking
> entirely new product features. Drafted 2026-04-27 after a full audit of
> existing Apify usage and the public Apify Store catalog (26.5K+ actors).

---

## 0. Context

### How this doc came to be

This roadmap was written after a debugging session that surfaced two problems
in production data:

1. ~150 KOL records in `kol_database` were stuck in `scrape_status='error'` or
   `scrape_status='scraping'` — failed scrapes from batch URL imports that
   never completed. Cleaned up in a one-shot DB pass.
2. Investigation revealed that influenceX's KOL profile-scraping pipeline
   silently fails on Instagram / TikTok / X without `MODASH_API_KEY`, and
   the Apify integration that exists in code is essentially dead weight —
   referenced in only one debug endpoint, never on the hot path.

That triggered a broader question: **given Apify offers 26.5K+ pre-built
scrapers, what should influenceX actually use them for?** This doc is the
answer.

### What's in scope

- Audit of current Apify code in the repo
- Capability mapping: existing influenceX modules ↔ Apify actors that fit
- **Net-new product features** Apify unlocks (not just gap-filling)
- Architectural changes required before any of this can ship safely
- Phased rollout plan with cost and risk estimates
- Reference catalog of relevant actors

### What's out of scope

- Replacing Apify with another platform (Bright Data, ScrapingBee, etc.) —
  decision already made, Apify wins on actor variety + pay-per-result model
- Building our own scrapers — explicitly the wrong move; Apify's whole value
  prop is they maintain the scrapers against platform anti-bot updates

---

## 1. Current State Audit

### 1.1 What's wired up today

The entire Apify surface in the codebase:

| File | Purpose | Status |
|---|---|---|
| `server/apify-client.js` (135 lines) | Wraps `run-sync-get-dataset-items` for two actors: `apify/instagram-profile-scraper`, `clockworks/tiktok-scraper` | Exists but unused on hot path |
| `server/index.js:36` | `const apify = require('./apify-client')` | Imported once |
| `server/index.js:2844` | `GET /api/apify/status` returning `{ configured }` | Probe-only endpoint |
| `APIFY_TOKEN` env var | Set in production via Cloud Run secret | Active |

### 1.2 The hot path bypasses Apify

`server/scraper.js` is what actually runs when KOLs get added:

- `scrapeInstagram` (line 274) — checks `MODASH_API_KEY`. If absent, returns
  `{ success: false, error: 'Instagram requires MODASH_API_KEY' }`. Never
  calls `apify.scrapeInstagram()` from `apify-client.js`.
- `scrapeTikTok` (line 152) — same pattern: Modash first, then a brittle
  Open Graph + `__UNIVERSAL_DATA_FOR_REHYDRATION__` HTML parser. Apify path
  is dead.
- `scrapeX` (line 345) — hardcoded `{ success: false, error: 'X/Twitter API
  requires paid access ($100+/month)' }`. Apify alternative exists at
  $0.25/1k tweets but isn't wired.
- `scrapeTwitch` (line 289) — Helix API requiring `TWITCH_CLIENT_ID/SECRET`.
  In production those vars resolve from Secret Manager but appear to be
  partially configured (we saw 74 rows stuck for 4 days at `followers=0`).
- `scrapeYouTube` (line 19) — uses YouTube Data API v3 directly. Subject to
  10K-units-per-day quota.

### 1.3 Architectural gaps

1. **Sync-only execution.** `run-sync-get-dataset-items` has a hard 5-minute
   ceiling. Bulk profile enrichment, hashtag deep-scrapes, and any actor
   that returns >100 items will time out or get truncated.
2. **No webhook receiver.** Resend (`/api/webhooks/resend/inbound`,
   `server/index.js:942`) and Stripe (`/api/billing/webhook`,
   `server/index.js:277`) both have receivers. Apify doesn't —
   asynchronous actor completion has nowhere to land.
3. **No actor registry.** Adding a new actor means hand-editing
   `apify-client.js` and writing one-off normalizers. There are ~25 actors
   we should be calling; this doesn't scale.
4. **No cost tracking per workspace.** Apify is pay-per-result. Without
   per-workspace cost attribution we can't enforce plan limits or bill
   accurately.
5. **No deduplication.** `content_scrape_cache` exists but is keyed on
   `content_url`, not `(platform, username)`. Re-scraping the same KOL
   profile 5 times in a week pays Apify 5 times.
6. **No quota guard.** `youtube-quota.js` exists for YouTube Data API but
   nothing equivalent for Apify spend. A runaway Discovery agent could burn
   the monthly budget in an hour.
7. **No batch primitive.** Most actors accept arrays as input
   (e.g. `usernames: ['a','b','c']`). Current client calls one-at-a-time.

---

## 2. Capability Gap Matrix

What influenceX needs ↔ what Apify offers ↔ priority.

| influenceX module / need | Current state | Apify actor (recommended) | Unit price | Priority |
|---|---|---|---|---|
| **KOL Profile — Instagram** | Modash-only, fails without key | `apify/instagram-profile-scraper` | $1.60 / 1k profiles | **P0** |
| **KOL Profile — TikTok** | Modash → OG parser fallback | `clockworks/tiktok-profile-scraper` (4.94★, highest in store) | $2.50 / 1k | **P0** |
| **KOL Profile — X/Twitter** | Hardcoded "$100/mo paid" stub | `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` | $0.25 / 1k | **P0** |
| **KOL Profile — YouTube** | Data API v3 (10k/day quota) | `streamers/youtube-channel-scraper` | $0.50 / 1k | **P1** (preserve quota) |
| **KOL Profile — Twitch** | Helix API (auth issues) | `automation-lab/twitch-scraper` (no creds needed) | event-based | **P1** |
| **KOL Profile — LinkedIn** | None | `dev_fusion/linkedin-profile-scraper` (with email enrichment) | $10 / 1k | **P2** (legal review required) |
| **KOL Discovery — IG / TikTok / X / Reddit** | Only YouTube via Data API | `apify/instagram-hashtag-scraper` ($1.90/1k) · `clockworks/tiktok-hashtag-scraper` ($2.00/1k) · `apidojo/twitter-scraper-lite` ($0.40/1k) · `apify/reddit-scraper` ($3.40/1k) | see left | **P0** |
| **Comments / Inbox harvesting** | `community.js` agent has X only; IG/TikTok/Reddit are stubs | `apify/instagram-scraper` (comments mode) · `clockworks/tiktok-comments-scraper` ($0.50/1k) · `streamers/youtube-comments-scraper` ($0.90/1k) | see left | **P1** |
| **Competitor content tracking** | `competitor-monitor.js` does live page fetch + diff only | `apify/instagram-post-scraper` · `apify/instagram-reel-scraper` · `clockworks/tiktok-scraper` (profile mode) | varies | **P1** |
| **Competitor ads intelligence** | None | `apify/facebook-ads-scraper` (Meta Ad Library, fully compliant) | $3.40 / 1k | **P2** |
| **Game / App reviews mining** | `review-miner.js` accepts URLs but no specialized actor | `easyapi/steam-reviews-scraper` · `neatrat/google-play-store-reviews-scraper` · `junglee/amazon-reviews-scraper` | $3 / 1k | **P1** (gaming clients) |
| **SEO / SERP monitoring** | `seo.js` uses SerpAPI | `apify/google-search-scraper` | $1.80 / 1k SERP pages | **P2** |
| **Lead-gen (B2B) email/phone** | Hunter.io domain-search only | `code_crafter/leads-finder` | $1.50 / 1k leads | **P2** |
| **Brand voice / RAG ingestion** | `brand_voices` table populated by manual upload | `apify/website-content-crawler` (markdown output) | $0.20–$5 / 1k pages | **P1** |
| **TikTok trends / discover** | None | `clockworks/tiktok-trends-scraper` · `clockworks/tiktok-discover-scraper` | event-based | **P2** |

---

## 3. Net-New Features Apify Unlocks

These are **product capabilities that don't exist anywhere in the codebase
today** — Apify is the missing ingredient that makes them buildable.

### 3.1 Trend Radar (P1)

**Pitch:** "Tell us what's about to blow up before your competitors notice."

**How it works:** Schedule `clockworks/tiktok-trends-scraper` +
`clockworks/tiktok-discover-scraper` + `apify/instagram-hashtag-scraper`
hourly per region. Diff hashtag/sound velocity vs. a 7-day rolling baseline.
Surface the top 20 fastest-rising tags/sounds in a "Trend Radar" UI.

**Surface in app:** New page `/trends` under ContentStudio. Each trend card
links to (a) sample posts using it, (b) "Find creators using this" → kicks
off a discovery run pre-filled with the hashtag.

**Why this matters:** Existing competitive intel is competitor-account
focused. Trend radar is platform-zeitgeist focused. Different signal, often
more actionable for content planning.

---

### 3.2 Sponsored-Post Detection & KOL Brand Affinity (P1)

**Pitch:** "Show me which KOLs already do paid work, with whom, how often."

**How it works:** For each KOL in a campaign, run `apify/instagram-post-scraper`
+ `clockworks/tiktok-scraper` (profile mode) on their last 30 posts. Apply
heuristics on captions: `#ad`, `#sponsored`, `#partner`, `@brandname`,
"in partnership with", platform's native paid-partnership tag, etc. Build
a `kol_brand_affinity` table:

```sql
CREATE TABLE kol_brand_affinity (
  kol_id TEXT REFERENCES kol_database(id),
  brand_handle TEXT,        -- the @brand they tagged
  collab_count INT,         -- how many times in last 30 posts
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  estimated_paid BOOL       -- did they use #ad / partnership tag
);
```

**Surface in app:** On KOL detail page, "Recent collaborations" section
showing the brands they've worked with. Useful for negotiating: a KOL who
just did 3 paid posts for competitors is a different ask than one who
hasn't done any.

---

### 3.3 Cross-Platform KOL Identity Resolution (P2)

**Pitch:** "@cozygamerkate on TikTok and IG: same person? Worth one ask or two?"

**How it works:** When a KOL is added on one platform, automatically run
fuzzy lookup actors on others — `apify/instagram-scraper` (search mode for
username), `clockworks/tiktok-user-search-scraper`, `streamers/youtube-scraper`
(search mode), `apidojo/twitter-scraper-lite`. Score matches by username
similarity + display name + bio overlap + linked URLs. Build unified
`kol_identity` table:

```sql
CREATE TABLE kol_identity (
  master_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  ...
);
ALTER TABLE kol_database ADD COLUMN identity_id TEXT REFERENCES kol_identity(master_id);
```

**Surface in app:** KOL list view groups multi-platform identities into one
row with platform badges. Outreach emails dedupe across platforms.

---

### 3.4 Sound-Driven Discovery (P2, TikTok-specific)

**Pitch:** "Find every creator riding the [Linkin Park - In the End] trend."

**How it works:** `clockworks/tiktok-sound-scraper` takes a sound URL and
returns recent videos using it. Ingest all unique creators from those videos
into a temporary cohort. Filter by follower range. Bulk-add into a
discovery_results campaign.

**Use case:** Brand wants to ride a viral sound. Instead of manual TikTok
browsing, get a ranked list of mid-tier creators who already use it. The
cohort is self-validating because they're the ones the algorithm has
already chosen to amplify.

---

### 3.5 Audience Demographics via Comment NLP (P2)

**Pitch:** "Audience demographics without paying Modash $99/mo per KOL."

**How it works:** For a target KOL, scrape ~1000 comments across their last
20 posts via `apify/instagram-scraper` or `clockworks/tiktok-comments-scraper`.
Run language detection + sentiment + named-entity extraction on the comment
text. Heuristically estimate: language distribution (proxy for region),
gender skew (proxy for ICP fit), engagement quality (real fans vs. bot/spam).

**Caveats:** Not as accurate as Modash's panel-based demo data. Pitched as
"directional audience signal" not ground truth.

**Cost per KOL:** ~$0.50–$1 (comments scrape) + LLM tokens (~$0.10) =
**< $1/KOL** vs. Modash $99/month.

---

### 3.6 Cross-Region KOL Discovery with Proxies (P1, gaming/HakkoAI relevant)

**Pitch:** "Find Japan/Korea/SEA creators in the genre we want."

**How it works:** Apify actors accept `proxyConfiguration.proxyCountry`. Run
hashtag/discover scrapers from Tokyo/Seoul/Bangkok IPs to surface the
regional creator pool that doesn't show up in US-default queries.

**Why this is non-trivial:** The platforms personalize discovery feeds by
viewer country. A US-IP scrape of `#indiegame` returns mostly US creators
even when we want JP creators.

---

### 3.7 Game Reviews → KOL Bridge (P0 for HakkoAI)

**Pitch:** "Your most enthusiastic Steam reviewer is also a 50K-sub YouTuber.
Recruit them."

**How it works:** Pipeline:

1. `easyapi/steam-reviews-scraper` pulls top positive reviews for a target
   game (or competitor's game).
2. For each reviewer, attempt cross-platform identity resolution (§3.3) —
   their Steam handle → search YouTube/Twitch/X for matching usernames.
3. If a match has > N followers, auto-create a KOL record with
   `source = 'steam-review'` and `recruitment_score` = review enthusiasm
   × creator size.
4. Surface in a "Super-fans worth recruiting" tab.

**Why this is gold for game studios:** These are pre-validated genre fans
who already make content. Conversion-to-collab rate should crush cold
outreach.

---

### 3.8 Live Sponsored-Deliverable Verification (P1)

**Pitch:** "Did the KOL actually post the deliverable? Verify automatically."

**How it works:** When a KOL accepts a paid campaign, schedule a recurring
`apify/instagram-post-scraper` (or platform equivalent) on their handle
starting from `expected_publish_date`. When a post matching campaign
hashtags / @-mentions appears, mark deliverable as verified, capture
post URL + early engagement metrics into `roi-dashboard`.

**Surface in app:** KOL contract view shows "Deliverable: published ✓
2026-05-12, 12.4K views, 890 likes (24h)".

**Already partially exists:** `roi-dashboard.js` has the schema. Apify gives
us the verification signal currently missing.

---

### 3.9 Look-alike KOL Cluster (P2)

**Pitch:** "These 5 KOLs converted well. Find 50 more like them."

**How it works:** Given seed KOLs, scrape their recent comments + follows
(where available) + hashtag co-occurrence. Build a lookalike search across:

- Hashtag overlap: which hashtags do all 5 use? Find creators using 3+ of
  those.
- Comment commenters: who comments frequently on the seed creators? They
  often have their own following.
- Sound overlap (TikTok specifically).

Rank candidates by overlap score, filter by follower range, surface in
discovery_results.

---

### 3.10 Competitor Hiring Signals (P3, B2B-ish)

**Pitch:** "Competitor just posted 3 'Influencer Marketing Manager' jobs.
Sales lead."

**How it works:** `bebity/linkedin-jobs-scraper` polls a watchlist of
competitor companies daily. Detect new postings for influencer-marketing /
content / community roles. Push to Slack/Notion as a sales signal.

**Use case:** indirect — useful for influenceX's own go-to-market, less for
end customers. Could be a feature ("intent intelligence") on enterprise plans.

---

### 3.11 Auto-Hydrate KOL Detail on Add (P0, UX)

**Pitch:** "When I paste a TikTok URL, the row populates in 5 seconds."

**How it works:** The current `POST /api/kol-database` endpoint inserts a
row in `scraping` state and triggers `scrapeAndEnrichKol` async. With
Apify webhook receiver (§4.1), the round-trip becomes:

1. Frontend: paste URL → `POST /api/kol-database` returns immediately with
   `id` and `scrape_status: 'scraping'`.
2. Backend: enqueue Apify run with webhook URL.
3. Apify finishes in ~30s, hits `/api/webhooks/apify`.
4. Webhook handler fetches dataset, normalizes, updates row to `complete`.
5. Frontend polls or SSE-subscribes; row populates live without a refresh.

This is a quality-of-life feature but it's the difference between
"I copy-paste 50 URLs and check back tomorrow" and "I copy-paste, see them
populate live, and start triaging immediately."

---

### 3.12 Auto Brand-Voice Ingestion (P1)

**Pitch:** "Point at our blog. Brand voice is captured."

**How it works:** Replace the manual upload flow for `brand_voices` with a
"Crawl my site" wizard:

1. User enters company URL.
2. `apify/website-content-crawler` recursively crawls (excludes auth pages,
   cookie modals stripped, markdown output).
3. Pages are chunked + embedded into `brand_voices` (already pgvector-ready
   per recent commits).
4. Brand voice agents auto-extract: tone descriptors, common phrases,
   forbidden terms, positioning statements.

**Cost per setup:** ~$0.20–$5 for a typical 100–1000 page site. One-time
per workspace.

---

### 3.13 Compliance / Proof-of-Publication Snapshots (P2)

**Pitch:** "Three months from now you'll need to prove they actually posted.
We saved the screenshot."

**How it works:** When `apify/instagram-post-scraper` (or equiv) finds the
deliverable post (per §3.8), also save a screenshot via
`apify/website-content-crawler` (or actor with screenshot mode), store in
GCS, link from `kol_contracts` row.

**Use case:** Legal/finance asks for proof of execution months later. Or a
KOL deletes the post mid-campaign and you need to prove it ran.

---

### 3.14 Comment-Reply QA Loop (P2)

**Pitch:** "Auto-reply via Inbox, then verify the reply landed and got engagement."

**How it works:** `community.js` agent already drafts/sends auto-replies on
inbox messages. After a reply is sent, schedule a follow-up scrape of the
target post's comment thread to confirm the reply is visible (not
shadow-banned), and track reactions. Feed back into the reply-quality model.

---

### 3.15 Mass Lookalike-by-Industry Lead Generation (P2)

**Pitch:** "Give me 500 indie game studios in EU with active Twitter."

**How it works:** Combine `code_crafter/leads-finder` (firmographic filter)
with `apidojo/twitter-scraper-lite` (handle lookup) and
`apify/instagram-profile-scraper`. Output is a sales list with verified
contact info + active social proof.

**Use case:** influenceX's own outbound, or as a B2B feature for clients
running creator-marketing-as-a-service.

---

### 3.16 Steam / Play Store Sentiment Watcher (P1, gaming clients)

**Pitch:** "Your game's review sentiment shifted negative this week. Here's why."

**How it works:** Daily `easyapi/steam-reviews-scraper` +
`neatrat/google-play-store-reviews-scraper` on client games. Detect
sentiment-shift moments (dropping average, surge in negative keywords).
Trigger Slack/email alerts with top 5 example negative reviews.

Builds on `review-miner.js` agent — that's a one-shot analyzer, this is
continuous monitoring.

---

### 3.17 Conference / Event KOL Mapping (P3)

**Pitch:** "GDC 2026 is in 6 weeks. Who's already creating content about it?"

**How it works:** Hashtag-driven discovery on event tags (#GDC2026, #IndieDevDay)
across IG/TikTok/X/Reddit. Filter by follower size. Output a "people creating
event-relevant content" list for sponsorship outreach.

---

### 3.18 Failure / Pruning Watchdog (P0, ops)

**Pitch:** Don't let zombie scrape rows accumulate.

**How it works:** Cron job (use existing `scheduler.js`) every hour:

```sql
UPDATE kol_database
SET scrape_status = 'error',
    scrape_error = 'Stuck >24h, marked as failed'
WHERE scrape_status = 'scraping'
  AND created_at < NOW() - INTERVAL '24 hours';
```

Plus a `/api/admin/apify-runs` view for ops to see failed runs and retry.

This directly prevents the "78 + 74 = 152 zombie rows" problem this doc was
born from.

---

### 3.19 KOL Engagement Forecast (P2)

**Pitch:** "If we partner with this KOL, expect 8–15K plays in 48h."

**How it works:** For a target KOL, scrape last 50 posts via
`clockworks/tiktok-scraper` (profile mode) or equivalent. Compute baseline
engagement distribution (median, p25, p75 of plays/likes/comments). Train a
simple model that incorporates: post recency decay, hashtag fit, sponsored
vs. organic differential, day-of-week effect.

Output: predicted reach interval for a new collaboration. Surface during
campaign planning.

---

### 3.20 Programmatic Brand-Mention Crawler (P1)

**Pitch:** "Where on the internet are people talking about us this week?"

**How it works:** Multi-actor brand-mention pipeline:

- `apify/google-search-scraper` for site-wide brand mentions (queries:
  `"brand_name" -site:brand.com`)
- `apify/reddit-scraper` for subreddit / comment mentions
- `apidojo/twitter-scraper-lite` for X mentions
- `apify/instagram-scraper` (search mode)
- `apify/website-content-crawler` on news domains for press mentions

Aggregate into a "Mention Inbox" with sentiment + author + reach signals.
This is essentially a competitor to Brand24 / Mention.com built on Apify.

---

## 4. Architectural Foundations

These are non-negotiable before any actor integration ships at scale.

### 4.1 Async + Webhook Execution Pipeline

Refactor `server/apify-client.js` to support three call modes:

```js
// 1. Sync — short tasks (<60s), keep existing API for back-compat
runActorSync(actorId, input, opts)

// 2. Async + poll — for long tasks where caller will block
const { runId, datasetId } = await runActorAsync(actorId, input)
await waitForCompletion(runId)  // polls /v2/actor-runs/{runId}

// 3. Async + webhook — fire and forget; webhook handler picks up the result
await runActorWithWebhook(actorId, input, {
  webhookUrl: `${BASE_URL}/api/webhooks/apify`,
  callbackTarget: 'kol_database',
  callbackPayload: { kolId },
})
```

Add `POST /api/webhooks/apify` parallel to the Resend / Stripe handlers.

### 4.2 Persistence: `apify_runs` table

```sql
CREATE TABLE apify_runs (
  id TEXT PRIMARY KEY,                      -- Apify runId
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT NOT NULL,                   -- e.g. 'apify/instagram-scraper'
  purpose TEXT,                             -- 'kol-discovery' | 'profile-enrich' | ...
  input JSONB,
  status TEXT,                              -- READY | RUNNING | SUCCEEDED | FAILED | TIMING_OUT | TIMED_OUT | ABORTED
  dataset_id TEXT,
  cost_usd REAL,                            -- from /actor-runs/{id}.usage.totalUsd
  callback_target TEXT,                     -- which table the result hydrates
  callback_payload JSONB,                   -- e.g. { kol_id, campaign_id }
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_apify_runs_workspace_status ON apify_runs(workspace_id, status);
CREATE INDEX idx_apify_runs_actor ON apify_runs(actor_id);
```

### 4.3 Actor Registry & Output Normalization

Create `server/apify-actors/`:

```
server/apify-actors/
  index.js                       # registry { id → adapter }
  _base.js                       # shared helpers
  instagram-profile.js           # { actorId, normalize(rawItem) → KolRow }
  instagram-hashtag.js
  instagram-post.js
  instagram-comments.js
  instagram-reel.js
  tiktok-profile.js
  tiktok-hashtag.js
  tiktok-comments.js
  tiktok-trends.js
  tiktok-sound.js
  twitter-profile.js
  twitter-search.js
  youtube-channel.js
  youtube-comments.js
  reddit-search.js
  twitch-channel.js
  facebook-ads.js
  linkedin-profile.js            # P2, gated by legal sign-off
  steam-reviews.js
  play-store-reviews.js
  app-store-reviews.js
  amazon-reviews.js
  google-search.js
  website-content.js
  leads-finder.js
```

Each adapter exports:

```js
module.exports = {
  actorId: 'apify/instagram-profile-scraper',
  defaultInput: (params) => ({ usernames: [params.username], resultsLimit: 1 }),
  normalize: (rawItem) => ({                // → kol_database schema
    platform: 'instagram',
    username: rawItem.username,
    display_name: rawItem.fullName,
    avatar_url: rawItem.profilePicUrlHD,
    followers: rawItem.followersCount,
    // ...
  }),
  estimatedCostPer: 'profile',              // for quota math
  estimatedCostUsd: 0.0016,
};
```

Adding a new actor = drop a file. No changes to `apify-client.js` or
business code.

### 4.4 Cache Layer

Extend `content_scrape_cache` or add `kol_profile_cache`:

```sql
CREATE TABLE kol_profile_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  platform TEXT,
  username TEXT,
  data JSONB,              -- normalized KolRow
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE (platform, username)
);
```

`scrapeProfile` in `server/scraper.js` checks cache first. TTL: 7 days for
non-paying tiers, 1 day for paying tiers (configurable per workspace plan).

### 4.5 Cost Tracking & Quota Guard

Mirror `youtube-quota.js`:

```js
// server/apify-quota.js
const PLAN_LIMITS = {
  starter:   { monthly_usd: 5 },
  growth:    { monthly_usd: 50 },
  enterprise:{ monthly_usd: null }, // unlimited
};

async function canRun(workspaceId, estimatedUsd) {
  const used = await getMonthlySpend(workspaceId);
  const limit = PLAN_LIMITS[plan].monthly_usd;
  if (limit !== null && used + estimatedUsd > limit) {
    return { allowed: false, used, limit };
  }
  return { allowed: true, used, limit };
}
```

Block actor runs that would breach the cap. Surface usage in the workspace
settings UI: "You've used $4.20 of $5 this month."

### 4.6 Failure Watchdog (already covered in §3.18)

Cron job to mark stuck `scraping` rows as `error` after 24h, plus an admin
dashboard at `/api/admin/apify-runs` showing recent failures.

---

## 5. Phased Roadmap

### Phase A — Resurrect KOL profile scraping (Week 1–2)

**Goal:** Make IG / TikTok / X profile scraping work without `MODASH_API_KEY`.
This affects every customer.

**Scope:**
- §4.1 async framework + webhook receiver
- §4.2 `apify_runs` table
- §4.3 minimal registry (4 adapters: ig-profile, tiktok-profile,
  twitter-profile, youtube-channel)
- §4.4 cache layer
- §4.5 cost tracking (block-mode optional in v1)
- §4.6 watchdog cron
- Rewrite `scraper.js` routing: `Apify > Modash > direct fetch > error`
- Re-run the 152 cleared rows to validate

**Success metrics:**
- 95%+ profile scrape success rate on IG / TikTok / X without Modash
- p95 latency < 60s for profile enrichment
- Zero new "stuck >24h" rows

---

### Phase B — Multi-platform discovery (Week 3–4)

**Goal:** Extend discovery beyond YouTube to IG / TikTok / X / Reddit.

**Scope:**
- 4 new adapters: ig-hashtag, tiktok-hashtag, twitter-search, reddit-search
- Extend `discovery.js` agent with `platform` input parameter (multi-select,
  default = all configured)
- Frontend: discovery page gets platform multi-picker
- Feature §3.6 (regional proxy support) baked into adapter config

**Success metrics:**
- Cross-platform discovery for "indie gaming" returns 200+ candidates per run
- Per-run cost stays under $2

---

### Phase C — Inbox / Community harvesting (Week 5)

**Goal:** Turn `community.js` agent's IG/TikTok/Reddit stubs into real handlers.

**Scope:**
- 4 comment adapters: ig-comments (uses `apify/instagram-scraper` comments
  mode), tiktok-comments, youtube-comments, reddit-comments
- Incremental scraping with `since_timestamp` cursor per (workspace, kol_id)
  to avoid double-billing
- Wire to existing `inbox_messages` table

---

### Phase D — Reviews & game/app sentiment (Week 6, gaming clients)

**Goal:** §3.7 (Steam-reviews → KOL bridge) and §3.16 (sentiment watcher).

**Scope:**
- 3 review adapters: steam, play-store, app-store
- Extend `review-miner.js` agent with `platform` + `app_id` routing
- §3.7 cross-platform bridge logic
- §3.16 daily sentiment-delta cron + alert wiring (Slack / Feishu, both
  already exist)

---

### Phase E — Brand & competitor intelligence (Week 7–8)

**Goal:** Programmatic brand-voice ingestion + competitor ad library +
sponsored-post detection.

**Scope:**
- §3.12 brand-voice auto-ingest (apify/website-content-crawler →
  brand_voices RAG)
- §3.2 sponsored-post detection (`kol_brand_affinity` table + UI)
- Facebook Ads Library adapter for `competitor-monitor.js`
- Frontend: KOL detail page gets "Recent collaborations" section

---

### Phase F — Net-new product features (Week 9+)

Ranked by ROI for HakkoAI / gaming-vertical customer:

1. §3.7 Steam → KOL bridge (P0 for HakkoAI)
2. §3.20 Brand-mention crawler
3. §3.1 Trend Radar
4. §3.8 Sponsored-deliverable verification (closes ROI dashboard loop)
5. §3.5 Comment-NLP demographics
6. §3.11 Live-hydrating KOL add UX
7. §3.9 Look-alike clusters
8. §3.4 Sound-driven discovery
9. §3.3 Cross-platform identity resolution
10. §3.19 Engagement forecast
11. §3.13 Compliance snapshots
12. §3.17 Event KOL mapping
13. §3.10 Hiring-signal lead-gen
14. §3.14 Comment-reply QA
15. §3.15 Lookalike-by-industry lead-gen

---

## 6. Cost Model

Assumptions: 100 customer workspaces, mid-tier usage profile.

| Use case | Monthly volume | Apify cost | Notes |
|---|---|---|---|
| KOL profile enrichment | 30 KOLs/ws × 100 = 3K. With 70% cache hit → 900 calls | ~$2 | IG/TikTok/X mix |
| Discovery scans (cross-platform) | 4/ws × 100 = 400 runs × ~$1.20/run | $480 | Hashtag + search across 4 platforms |
| Comments harvesting (active KOLs) | 50K comments | ~$30 | Mostly IG + TikTok |
| Reviews scraping (gaming clients ~30%) | 20K reviews | $60 | Steam + Play Store |
| Brand voice / RAG crawl | 5K pages | $10–25 | One-off per workspace |
| SERP monitoring (replaces partial SerpAPI) | 5K queries | $9 | Optional |
| Brand-mention pipeline | 10K results | $25 | Multi-actor fan-out |
| **Total** | | **~$620–650 / month** | |

**Comparison to current Modash spend:** Modash starts at $99/month per seat
+ usage. At 100 workspaces with even 1 seat each, baseline is ~$10K/month
plus per-call costs. **Apify replacement saves >90% on this category** while
adding platforms Modash doesn't cover (X, Reddit, Twitch, Steam reviews,
Google Maps, Ad Library).

**Per-workspace cost per plan tier (suggested billing):**
- Starter ($29/mo): $5 Apify cap → blocked above
- Growth ($99/mo): $50 Apify cap → blocked above
- Enterprise: unmetered, true cost passed through

---

## 7. Risks & Mitigations

### 7.1 Apify is also fighting anti-bot

IG / X / TikTok escalate scraping defenses regularly. Even maintained actors
have failure spikes. **Mitigation:**

- All scrape calls double-routed: Apify → fallback (Modash if key present /
  direct fetch / error). Routing logic in `scraper.js` (Phase A).
- `apify_runs.status` monitoring; if failure rate > 20% over 24h on a given
  actor, auto-switch primary route and page on-call.

### 7.2 LinkedIn legal exposure

LinkedIn UA explicitly prohibits scraping. `dev_fusion/linkedin-profile-scraper`
exists and works, but using it carries litigation risk (hiQ Labs v. LinkedIn
provides some shelter for public profile data, but the legal landscape is
evolving). **Mitigation:**

- Phase F LinkedIn adapter ships disabled by default
- Enterprise plan only, with a separate opt-in toggle
- Legal review documented before enabling per workspace
- Don't scrape data behind login walls under any circumstances

### 7.3 Cost runaway

Pay-per-result + buggy discovery agent = burn budget in an hour. **Mitigation:**

- §4.5 quota guard ships before any actor goes into production
- Default per-workspace cap on all plans
- Per-actor hourly rate limit (e.g. max 1000 results/hour per workspace)
- Cost preview UI: "This run will cost ~$0.40" before user clicks Run

### 7.4 Production data pollution (this doc's origin sin)

Batch URL imports landing as `scrape_status='scraping'` and never resolving.
**Mitigation:**

- §4.6 watchdog cron auto-marks stuck rows
- §4.1 webhook architecture means "completion event" is reliable, not a
  hopeful setTimeout
- Admin dashboard for ops to triage failures

### 7.5 PII / GDPR for emails & phones

Apify lead-finder + LinkedIn enrichment surface emails and phones. **Mitigation:**

- All PII fields encrypted at rest using `MAILBOX_ENCRYPTION_KEY` (already
  established pattern in mailbox tables)
- Per-workspace data retention policy: emails purgable on workspace deletion
- Don't expose raw enrichment data to non-admin roles

### 7.6 Vendor lock-in to Apify

If Apify changes pricing or shuts down, we lose discovery + enrichment
overnight. **Mitigation:**

- Keep `scraper.js` routing layer abstract — Apify is one provider, Modash
  is another
- Adapter pattern (§4.3) means a swap is one file per platform, not a
  rewrite
- Acknowledge: full provider redundancy isn't worth building until we're at
  >$5K/month Apify spend

---

## 8. Open Questions

1. **Modash retention:** keep Modash as fallback (extra $99/mo, dead weight
   when Apify works) or drop it? Recommend keeping for one quarter post-Phase A
   to validate Apify success rate, then drop.
2. **Self-hosted Apify proxy?** Apify offers proxy renting. Worth it for
   regional discovery (§3.6) but adds ~30% to per-call cost.
3. **MCP server angle:** Apify recently exposed actors via MCP. Could we
   wire actors directly into agents-v2 as MCP tools instead of building our
   own adapter layer? Trade-off: less control over normalization, but
   instant catalog access.
4. **Webhook signing verification:** Apify webhooks support HMAC signing.
   Confirm we verify before processing (parallels Stripe / Resend handlers).
5. **Pricing pass-through model:** customers see Apify costs as line items
   ("Discovery scan: $1.20") or absorbed into plan price? Recommend: absorbed
   into plan with hard cap, transparent usage UI.

---

## 9. Suggested First Sprint

If green-lit, here's what week 1 looks like:

**Day 1–2:** §4.1 async framework + webhook handler + `apify_runs` table
migration. PR: `feat(apify): async runtime + webhook receiver`.

**Day 3:** §4.3 registry + 4 minimum adapters (ig-profile, tiktok-profile,
twitter-profile, youtube-channel). PR: `feat(apify): actor registry + 4
profile adapters`.

**Day 4:** §4.4 cache layer + §4.5 cost tracking (read-only first, no
blocking). PR: `feat(apify): profile cache + cost tracking`.

**Day 5:** Rewrite `scraper.js` routing. Re-run the 152 cleared rows in
staging. PR: `refactor(scraper): route via Apify when configured`.

**Day 6–7:** §4.6 watchdog cron + ops dashboard. Production rollout behind
feature flag (`APIFY_ROUTING=primary` env var). Monitor for 48h.

**End-of-sprint deliverable:** every customer's profile-scraping pipeline
works without Modash, the 152-row data-pollution incident is structurally
prevented, and the foundation is ready for Phases B–F.

---

## Appendix A: Actor Catalog (relevant to influenceX)

### Social media — profile / discovery / content

| Actor ID | Platform | What it does | Price |
|---|---|---|---|
| `apify/instagram-scraper` | Instagram | All-in-one: profiles, posts, hashtags, comments | $1.50/1k |
| `apify/instagram-profile-scraper` | Instagram | Profile-only | $1.60/1k |
| `apify/instagram-post-scraper` | Instagram | Posts | $1.00/1k |
| `apify/instagram-reel-scraper` | Instagram | Reels | $1.00/1k |
| `apify/instagram-hashtag-scraper` | Instagram | Hashtag feeds | $1.90/1k |
| `apify/instagram-followers-count-scraper` | Instagram | Just follower count | $1.30/1k |
| `clockworks/tiktok-scraper` | TikTok | Mixed inputs | $1.70/1k |
| `clockworks/tiktok-profile-scraper` | TikTok | Profile-level (4.94★) | $2.50/1k |
| `clockworks/tiktok-comments-scraper` | TikTok | Comments | $0.50/1k |
| `clockworks/tiktok-hashtag-scraper` | TikTok | Hashtag feeds | $2.00/1k |
| `clockworks/tiktok-trends-scraper` | TikTok | Rising trends | event-based |
| `clockworks/tiktok-discover-scraper` | TikTok | Discover feed | event-based |
| `clockworks/tiktok-sound-scraper` | TikTok | Videos using a sound | event-based |
| `streamers/youtube-scraper` | YouTube | Mixed (channels, videos, search) | $2.40/1k |
| `streamers/youtube-channel-scraper` | YouTube | Channel-only (cheapest) | $0.50/1k |
| `streamers/youtube-comments-scraper` | YouTube | Comments | $0.90/1k |
| `streamers/youtube-shorts-scraper` | YouTube | Shorts | $2.40/1k |
| `codepoetry/youtube-transcript-ai-scraper` | YouTube | Transcripts (Whisper fallback) | $0.70/1k |
| `apidojo/twitter-scraper-lite` | X | Mixed (search, profile, list, conversation) | event-based |
| `apidojo/tweet-scraper` (V2) | X | Advanced search | $0.40/1k |
| `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` | X | Cheapest | $0.25/1k |
| `epctex/twitter-profile-scraper` | X | Profile-only | $10/mo + usage |
| `apify/facebook-pages-scraper` | Facebook | Page metadata | $10/1k |
| `apify/facebook-posts-scraper` | Facebook | Page posts | $2/1k |
| `apify/facebook-ads-scraper` | Facebook | Meta Ad Library (compliant) | $3.40/1k |
| `apify/facebook-groups-scraper` | Facebook | Public groups | $2.60/1k |
| `apify/reddit-scraper` | Reddit | All-in-one | $3.40/1k |
| `trudax/reddit-scraper-lite` | Reddit | Same as above (alt vendor) | $3.40/1k |
| `automation-lab/twitch-scraper` | Twitch | Streams, profiles, games (no auth) | event-based |
| `dev_fusion/linkedin-profile-scraper` | LinkedIn | Profile + email enrichment | $10/1k |
| `harvestapi/linkedin-profile-search` | LinkedIn | Filtered search | $0.10/page + $0.004/profile |
| `harvestapi/linkedin-company` | LinkedIn | Companies | $3/1k |
| `harvestapi/linkedin-company-employees` | LinkedIn | Company employee lists | varies |
| `bebity/linkedin-jobs-scraper` | LinkedIn | Job postings | $29.99/mo + usage |
| `nocodeventure/bluesky-scraper` | Bluesky | Posts/profiles via AT Protocol | event-based |

### Reviews & e-commerce

| Actor ID | Source | Use | Price |
|---|---|---|---|
| `easyapi/steam-reviews-scraper` | Steam | Game reviews | event-based |
| `neatrat/google-play-store-reviews-scraper` | Play Store | App reviews | event-based |
| `junglee/amazon-crawler` | Amazon | Products | $3/1k |
| `junglee/amazon-reviews-scraper` | Amazon | Product reviews | $3/1k |
| `compass/crawler-google-places` | Google Maps | Places | $2.10/1k |
| `compass/google-maps-reviews-scraper` | Google Maps | Reviews | $0.30/1k |
| `lukaskrivka/google-maps-with-contact-details` | Google Maps | Places + emails | $2.10/1k |

### Search / web / RAG

| Actor ID | Use | Price |
|---|---|---|
| `apify/google-search-scraper` | Google SERP (organic, ads, PAA, AI Mode) | $1.80/1k |
| `apify/website-content-crawler` | Crawl websites → markdown for LLMs | $0.20–$5/1k pages |

### Lead generation

| Actor ID | Use | Price |
|---|---|---|
| `code_crafter/leads-finder` | B2B people + company search (Apollo/ZoomInfo alt) | $1.50/1k |

---

## Appendix B: Source Material

This roadmap was researched from:

- [Apify Store homepage](https://apify.com/store)
- [Best Apify Social Media Scrapers 2026](https://use-apify.com/docs/best-apify-actors/best-social-media-scrapers)
- [Best Apify Actors hub 2026](https://use-apify.com/docs/best-apify-actors)
- [apify/instagram-scraper](https://apify.com/apify/instagram-scraper)
- [clockworks/tiktok-scraper](https://apify.com/clockworks/tiktok-scraper)
- [streamers/youtube-scraper](https://apify.com/streamers/youtube-scraper)
- [apidojo/tweet-scraper](https://apify.com/apidojo/tweet-scraper)
- [dev_fusion/linkedin-profile-scraper](https://apify.com/dev_fusion/linkedin-profile-scraper)
- [apify/google-search-scraper](https://apify.com/apify/google-search-scraper)
- [code_crafter/leads-finder](https://apify.com/code_crafter/leads-finder)
- [apify/website-content-crawler](https://apify.com/apify/website-content-crawler)
- [Apify Webhooks complete guide 2026](https://use-apify.com/blog/apify-webhooks-complete-guide)
- [Apify run-actor patterns docs](https://docs.apify.com/academy/api/run-actor-and-retrieve-data-via-api)

In-repo references:

- `server/apify-client.js` — current minimal client
- `server/scraper.js` — hot-path scraping where Apify is bypassed
- `server/agents-v2/` — agents that would benefit from Apify integration
  (community, competitor-monitor, discovery, review-miner, seo)
- `server/index.js:2844` — current `/api/apify/status` endpoint
- `server/index.js:942` / `server/index.js:277` — Resend / Stripe webhook
  patterns to mirror for Apify

---

*Last updated: 2026-04-27. Owner: TBD. Status: Proposal.*
