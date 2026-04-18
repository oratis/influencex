# InfluenceX → AI Content Marketing Agents Platform

**Roadmap & Product Design · 2026 Q2 pivot**

> Evolving InfluenceX from a KOL outreach tool into a **multi-agent AI platform** that runs a brand's entire content marketing operation — creator partnerships, content generation, multi-channel publishing, paid ads, community, and analytics — all orchestrated by specialized AI agents that collaborate in the background.

---

## 0. Executive summary

**Today** (`influencexes.com` v0.8)
- A vertical tool: *KOL discovery + outreach pipeline + ROI tracking*
- Good foundation: RBAC, queue, cache, i18n, CI, tests, OpenAPI, scheduler, Docker Compose, etc.
- Single-workflow: brand finds creators → emails them → tracks contracts & content

**Target** (v2.0, "InfluenceX Agents")
- A **horizontal platform**: *one dashboard, many AI agents, every channel*
- Positioning: **"Your content marketing runs itself while you sleep."**
- Agent-first UX: users describe goals, agents execute; human approves key gates
- Channels: creator marketing (keep, expand), owned social, email, paid ads, SEO, community

**Why pivot**
1. KOL-only is a crowded niche (Modash, Heepsy, CreatorIQ, AhaCreator) with race-to-the-bottom pricing
2. Brands want one tool, not ten — content marketing is fragmenting across channels faster than tooling
3. LLMs have made "agent that writes + posts + analyzes" actually viable in 2026
4. We already have the hard parts: auth, RBAC, queue, multi-platform API, email, scheduler. Agent orchestration is additive
5. Greater LTV, higher willingness to pay, broader TAM

---

## 1. Competitive landscape

| Competitor | Strength | Weakness | Our wedge |
|---|---|---|---|
| **AhaCreator** | 5M creator database, escrow payments, end-to-end outreach | Only influencer marketing; no content generation; no owned-channel publishing | We do both influencer + owned channels + generated content in one loop |
| **HubSpot** | Full CRM + marketing automation, trusted enterprise brand | Slow on AI-native features; pre-agent era UI; expensive per seat | AI-agent-first from day one; 10× cheaper for SMB |
| **Jasper/Copy.ai** | Great AI copywriting | No distribution, no creator mgmt, no ROI loop | We close the full loop: create → distribute → measure → iterate |
| **Buffer/Hootsuite** | Solid scheduler for owned social | No AI, no creators, weak analytics | Scheduler is one agent among many, not the whole product |
| **Meta/Google Ads** | Native ads | No orchestration across channels, no content generation | Unified spend + creative across Meta, Google, TikTok, YouTube |
| **Linear/Asana-style** | Workflow tools | Not marketing-specific | Opinionated marketing primitives + agents |

**Moat:** Multi-agent orchestration across creator + owned + paid channels is a technical gap nobody has nailed yet. Being open-source (MIT) gives us distribution leverage competitors can't match.

---

## 2. Product vision

### 2.1 One-sentence positioning

> **InfluenceX is a team of AI agents that plans, creates, distributes, and measures your content marketing across every channel — creators, social, email, ads, SEO — with you approving the decisions that matter.**

### 2.2 Target users (Jobs-to-be-done)

| Segment | Hiring us for |
|---|---|
| **Solo founders / bootstrappers** | "I'm one person. Run my marketing like a 5-person team." |
| **Growth marketers at seed/Series-A startups** | "I don't have time to hire specialists for every channel." |
| **Content agencies** | "Let me manage 20 client accounts without 20 employees." |
| **Creator brands (personal-brand businesses)** | "Orchestrate my content so I can focus on making it." |
| **DTC / e-commerce SMBs** | "Help me turn customers into creators, scale UGC, and close the loop on ROI." |

### 2.3 North-star metric

**Hours of marketing work automated per week per user.** Every feature contributes a measurable delta. Target: 20+ hours/week automated for an active SMB within 6 months.

---

## 3. Agent architecture

The platform is a swarm of **specialized agents** coordinated by a **Conductor**. Each agent has a narrow mandate, clear inputs/outputs, and a cost/quality profile.

### 3.1 Agent roster (v2.0 scope)

```
                      ┌──────────────────────┐
                      │   Conductor Agent    │
                      │  (goal → plan → run) │
                      └──────────┬───────────┘
                                 │
    ┌────────────┬───────────────┼────────────┬──────────────┐
    ▼            ▼               ▼            ▼              ▼
┌─────────┐ ┌─────────┐    ┌──────────┐ ┌──────────┐  ┌────────────┐
│Strategy │ │Research │    │ Content  │ │ Discovery│  │ Publisher  │
│ Agent   │ │ Agent   │    │  Agent   │ │ Agent    │  │ Agent      │
│         │ │         │    │  (text,  │ │ (creators│  │ (schedules │
│ ICP,    │ │ trends, │    │  image,  │ │  + email)│  │  to 6+     │
│ brand,  │ │ kw, SEO,│    │  script) │ │          │  │  channels) │
│ comp    │ │ competi-│    │          │ │          │  │            │
│         │ │ tors    │    │          │ │          │  │            │
└─────────┘ └─────────┘    └──────────┘ └──────────┘  └────────────┘
    │            │               │            │              │
    └────────────┴───────────────┼────────────┴──────────────┘
                                 ▼
    ┌────────────┬───────────────┼────────────┬──────────────┐
    ▼            ▼               ▼            ▼              ▼
┌─────────┐ ┌─────────┐    ┌──────────┐ ┌──────────┐  ┌────────────┐
│Outreach │ │   Ads   │    │Community │ │Analytics │  │   Brand    │
│ Agent   │ │ Agent   │    │  Agent   │ │  Agent   │  │   Safety   │
│(creator │ │(Meta/   │    │(DMs,     │ │(reports, │  │   Agent    │
│ + email │ │ Google/ │    │ comments,│ │ attribu- │  │(fraud,     │
│ negoti- │ │ TikTok  │    │ reviews) │ │ tion)    │  │ sentiment, │
│ ation)  │ │ Ads)    │    │          │ │          │  │ fake users)│
└─────────┘ └─────────┘    └──────────┘ └──────────┘  └────────────┘
```

### 3.2 Agent contract (every agent obeys this)

```typescript
interface Agent {
  id: string;                    // e.g. "content-agent"
  name: string;                  // "Content Writer"
  description: string;
  capabilities: Capability[];    // declarative list, e.g. ["write.twitter", "write.blog"]
  inputs: JSONSchema;            // what it accepts
  outputs: JSONSchema;           // what it produces
  costEstimate(input): Cost;     // { tokens, usdCents, seconds }
  run(input, ctx): AsyncIterable<Event>; // streams progress + results
}
```

Every agent:
- Is **idempotent by default** (same input → same output, cacheable)
- Emits **structured events** (started, progress, result, error, human-approval-required)
- Is **introspectable** — every decision produces a trace that the user can read
- Has an **explicit cost meter** so the UI can show "this run will cost ~$0.40"
- Can be **replaced independently** (plug GPT-5 into Content Agent without touching others)

### 3.3 Conductor (orchestration)

The Conductor is itself an agent, but a special one that:
1. Takes a **goal** in natural language: *"Run a 30-day launch campaign for our new feature X targeting SaaS founders"*
2. Breaks it into a **plan** (DAG of agent tasks)
3. Shows the plan to the human for approval ("You'll spend ~$240 over 30 days, reach ~40K people across YouTube + X + LinkedIn")
4. Dispatches tasks to agents via the existing job-queue
5. Manages **human-in-the-loop gates** (e.g. "approve this email copy before sending")
6. Replans on failure or when the human changes direction

### 3.4 Why this shape?

- **Modularity** → we can ship agents one at a time; users get value incrementally
- **Parallel competition** → we can A/B two content agents (Claude vs GPT-5) and route based on quality
- **Cost control** → users set budgets per campaign; Conductor respects them
- **Trust** → agents show their work; decisions are always auditable
- **Extensibility** → 3rd-party agents via plugin API (marketplace in later phase)

---

## 4. Feature map (v2.0 complete scope)

### 4.1 For brands / marketers

| Module | v2.0 features |
|---|---|
| **Strategy workspace** | ICP builder, competitive scan, content pillars, monthly themes, brand voice trainer |
| **Content studio** | AI copy (blog, caption, email, ad), AI image (brand-consistent), video script & storyboard, localize to 12+ languages |
| **Calendar** | Drag-drop cross-channel calendar, auto-populate by theme, agent-suggested slots |
| **Creators** | (existing) discovery, outreach, contracts, payments; PLUS creator CRM, contract templates, escrow, negotiation agent |
| **Publisher** | Schedule + publish to YouTube, TikTok, Instagram, X, LinkedIn, Facebook, Pinterest, Reddit, Threads, newsletter |
| **Ads** | Plan + create + launch + optimize across Meta, Google, TikTok, LinkedIn Ads; unified reporting |
| **SEO** | Keyword research, on-page briefs, backlink monitor, content refresh suggestions |
| **Community** | Inbox for DMs/comments across channels, auto-reply, priority triage, moderation |
| **Analytics** | Unified dashboard, attribution, funnel, ROI per channel/creator/asset, agent-generated weekly reports |
| **Brand safety** | Mention monitoring, sentiment alerts, fake-follower detection, deepfake screening |

### 4.2 For creators (marketplace side)

| Module | v2.0 features |
|---|---|
| **Profile** | Auto-built from connected platforms; stats, rate card, portfolio |
| **Opportunities** | Matched campaigns, one-click apply, counter-offer tooling |
| **Workspace** | Brief reader, content uploads, revision threads, deliverable tracker |
| **Getting paid** | Escrow, invoicing, tax forms (US W-9, EU VAT), same-day payouts |
| **Insights** | Benchmark your rates, see industry trends |

### 4.3 For platform admins (us)

- Multi-tenant isolation, per-workspace billing
- Usage metering (agent tokens, API calls)
- Admin analytics (MRR, agent quality scores, model spend)
- Agent catalog CMS, plugin approvals

---

## 5. Roadmap — 8 phases, 9 months

Each phase is 4–6 weeks. Cumulative; every phase ships something useful on its own.

### Phase A: Agent framework foundation (Weeks 1–5)

**Goal:** Build the plumbing so any new capability can be shipped as an agent.

| Work | Deliverable |
|---|---|
| Agent runtime | `server/agent-runtime/` — registration, lifecycle, cost accounting, event streaming |
| Conductor prototype | NL goal → structured plan; Claude/GPT-5 tool-calling loop with typed schemas |
| LLM abstraction | `server/llm/` — providers (Anthropic, OpenAI, local), rate limits, retries, cost tracking |
| Trace storage | Persist every agent invocation + decision for audit and debugging |
| Agent testing harness | Golden-input regression tests; eval framework |
| Refactor existing code | Scraper / discovery / email-sender move under `agent-runtime`, keep API backward-compat |

**Shipped:** Existing pipeline still works, now running on top of agent runtime.

### Phase B: Content generation agents (Weeks 6–10)

**Goal:** Users can generate high-quality content for any channel in one click.

| Agent | Does |
|---|---|
| **Strategy Agent** | Interviews user about brand, synthesizes ICP + content pillars; outputs editable profile |
| **Research Agent** | Given a topic, gathers trends, top-ranking content, competitor angles, keyword data |
| **Content Agent — Text** | Blog posts, social captions, email copy, ad copy; brand-voice adapter |
| **Content Agent — Visual** | Brand-consistent images via DALL-E 3/Midjourney/SD; templated compositions (quotes, stats) |
| **Content Agent — Video** | Short-form video scripts + storyboards + thumbnail text |
| Content UI | "Content Studio" page with side-by-side editor + preview + agent chat |

**Metric:** First user creates 10 pieces of polished content in <30 min.

### Phase C: Multi-channel publisher (Weeks 11–14)

**Goal:** Schedule and publish across 6+ channels with one click.

| Work | Details |
|---|---|
| **Publisher Agent** | Post to YouTube, TikTok (new API), Instagram (Meta Graph), X, LinkedIn, Facebook, Threads |
| **Channel connectors** | OAuth setup, token refresh, rate-limit-aware batching |
| **Calendar UI** | Month/week/day views, drag-drop, theme filters |
| **Approval workflow** | Editor drafts → Approver approves → Publisher schedules |
| **Localization** | Auto-translate + locale-specific tweaks (emojis, idioms) via Translate Agent |

**Metric:** User schedules 30-day content calendar in <1 hour.

### Phase D: Paid ads orchestration (Weeks 15–18)

**Goal:** Plan + launch + optimize ads across major platforms without leaving the app.

| Work | Details |
|---|---|
| **Ads Agent** | Given creative + audience + budget, spins up ads on Meta, Google, TikTok, LinkedIn |
| **Budget optimizer** | Reallocates daily based on CPA / ROAS per channel |
| **Creative generator** | Hooks into Content Agent to spin out 10 variants, runs multivariate test |
| **Reporting** | Unified dashboard across ad accounts; attribution via UTMs + conversion pixel |

**Metric:** First campaign goes live within 15 min of "launch ads" click.

### Phase E: Creator workflow v2 (Weeks 19–22)

**Goal:** Make InfluenceX's original strength (creator outreach) 10× better and marketplace-ready.

| Work | Details |
|---|---|
| **Creator marketplace** | Curated pool of 10K+ pre-verified creators (seed by scraping + importing public databases) |
| **Match Agent** | Given brief, returns top 50 creators with rationale |
| **Negotiation Agent** | Handles rate back-and-forth automatically within budget bounds |
| **Contracts** | DocuSign/Dropbox Sign integration; dual-sided e-sign |
| **Escrow** | Stripe Connect for payment-on-delivery; partial releases on milestones |
| **Creator portal** | Separate subdomain/UI for creators to log in, accept briefs, submit content |

**Metric:** Brand launches a 10-creator campaign in <30 min, end-to-end.

### Phase F: Analytics & optimization (Weeks 23–26)

**Goal:** Close the loop. Every dollar is tracked, every agent learns.

| Work | Details |
|---|---|
| **Analytics Agent** | Aggregates data across every channel + creator + piece; builds weekly reports |
| **Attribution engine** | First-touch, last-touch, multi-touch; user-level funnel (if site connected) |
| **Optimization loop** | Agent suggests: "kill ad X, double down on creator Y, repurpose post Z as ad" |
| **A/B testing framework** | Every content variant is tested; Conductor replans based on winners |
| **Unified dashboard** | ROI across all channels, cost per outcome, trends |

**Metric:** Average user sees ≥20% lift in engagement or CAC by month 2.

### Phase G: Community & customer loop (Weeks 27–30)

**Goal:** Don't just broadcast — converse.

| Work | Details |
|---|---|
| **Community Agent** | Unified inbox: DMs (IG, X, LinkedIn), comments, YouTube, email |
| **Auto-triage** | Sentiment, priority, FAQ detection; drafts replies the human can send |
| **Review mining** | Extracts testimonials + pain points from comments; feeds into Research Agent |
| **CRM lite** | Track relationships with VIP followers, top commenters, superfans |
| **Integrations** | Intercom, Zendesk, Help Scout webhooks to hand off hot leads |

**Metric:** Median response time on social DMs drops from hours to <10 min.

### Phase H: Platform & scale (Weeks 31–36)

**Goal:** Multi-tenant SaaS, developer ecosystem, enterprise ready.

| Work | Details |
|---|---|
| **Multi-workspace** | One account, many brands (for agencies); per-workspace isolation + billing |
| **Usage-based billing** | Stripe metered subscriptions; agent tokens, API calls, publish slots |
| **Plugin API** | 3rd parties ship agents; sandboxed; reviewed; revenue share |
| **White-label** | Agencies can rebrand + resell |
| **Enterprise** | SSO (Google, Okta, Azure AD), audit logs, SOC 2 groundwork, EU data residency |
| **Self-serve onboarding** | Conductor walks a new signup through strategy + first content + first post in <10 min |

**Metric:** First 100 paying workspaces; $20K MRR milestone.

---

## 6. Stretch / post-v2.0 ideas

Not scheduled, but in backlog:

- **Video agent** that actually generates short videos (Runway / Sora API)
- **Podcast agent** — turn blog posts into a narrated podcast + publish to Spotify/Apple
- **Shopify / Stripe deep integration** — close the loop to revenue per post
- **Live-shopping agent** — schedule + run live streams, manage inventory
- **International arbitrage agent** — auto-translate + repost winning content to 10 locales
- **Competitive "war room"** — always-on monitor of competitor moves, proactive suggestions
- **Voice of customer AI** — listens to calls (via Gong/Chorus), feeds insights into Strategy Agent
- **Open-source model hosting** — run Llama/Mistral on cheap GPUs for cost-sensitive users

---

## 7. Technical evolution

### 7.1 Stack additions by phase

| Phase | New tech | Reason |
|---|---|---|
| A | Anthropic + OpenAI SDKs, SSE/WebSocket for streams | Agent runtime |
| A | OpenTelemetry traces | Debuggability of agent chains |
| B | Image models (OpenAI DALL-E, Replicate/Stability SDK) | Visual content |
| B | Vector DB (Postgres pgvector) | Brand-voice embedding, content similarity |
| C | OAuth for 8+ social networks | Publishing |
| C | BullMQ + Redis (swap in-process queue) | Reliable distributed scheduling |
| D | Meta/Google/TikTok Ads APIs | Paid |
| E | Stripe Connect, DocuSign, Dropbox Sign | Contracts & payments |
| F | ClickHouse or TimescaleDB | Analytics at scale |
| F | Attribution library (Segment CDP or DIY) | Multi-touch |
| G | WebSocket gateway for inbox | Real-time |
| H | Stripe Billing, SSO (Auth0 or WorkOS) | Enterprise |

### 7.2 Rewrite vs refactor strategy

- **Keep** (good bones): Express routes, Postgres schema, auth/RBAC, i18n, rate-limit, CORS, health, ETag, CSV, queue (for now), scheduler, notifications, CI, tests
- **Evolve**: `scraper` → `discovery-agent`, `mail-agent` → `outreach-agent`, `data-agent` → `analytics-agent` — all become Agent-interface implementations
- **Rewrite**: N/A — nothing needs full rewrite

### 7.3 Data model evolution

New tables in Phase A:
- `agents` (id, type, version, config)
- `agent_runs` (id, agent_id, workspace_id, status, cost_usd, input, output, started_at, completed_at, trace_url)
- `agent_traces` (id, run_id, step, decision, llm_tokens, duration_ms)
- `workspaces` (multi-tenant primary key propagates through all existing tables)
- `workspace_members` (user_id, workspace_id, role)

New tables in Phase B:
- `content_pieces` (id, workspace_id, type, title, body, status, channel_targets)
- `content_variants` (id, content_piece_id, platform, localized_body, a_b_group)
- `brand_voices` (id, workspace_id, embedding, style_guide)

New tables in Phase C:
- `channel_connections` (id, workspace_id, platform, oauth_token, expires_at)
- `scheduled_posts` (id, content_variant_id, channel_connection_id, scheduled_for, published_at, platform_post_id, metrics)

### 7.4 Breaking changes & migration

- **URL structure**: `/api/v2/*` introduced for new endpoints. v1 frozen, deprecated after Phase H.
- **Schema**: every migration additive; legacy tables live forever until Phase H cleanup
- **Client**: progressive — each phase ships a new page; old pages still work
- **Open-source users**: documented upgrade guide per phase; release notes in CHANGELOG

---

## 8. Business & pricing

### 8.1 Pricing model (v2.0)

**Freemium + usage-based**, open-source self-host is free forever.

| Tier | $/month | Target | Limits |
|---|---|---|---|
| **Open Source** | $0 | Self-host enthusiasts | Unlimited, bring your own keys |
| **Starter** | $49 | Solo founders | 1 workspace, 5K agent tokens, 30 posts/mo, 5 ad creatives |
| **Growth** | $199 | Startups | 3 workspaces, 50K tokens, 300 posts, unlimited ads creatives, 10 creators |
| **Scale** | $699 | Scaleups | 10 workspaces, 500K tokens, unlimited posts, unlimited creators, priority support |
| **Enterprise** | Custom | 50+ seats | SSO, custom contracts, SOC 2, dedicated CSM |

Usage overage: pay-as-you-go on agent tokens beyond tier.

### 8.2 Go-to-market

1. **Open-source distribution** — the free version sells the paid version; stars → signups
2. **Product-led** — sign up, hit "run a 30-day launch campaign" in 5 min, see value, convert on agent token overage
3. **Content marketing (dogfooding!)** — every Friday the Conductor publishes our own week-in-review
4. **Creator marketplace flywheel** — creators sign up free, brands pay → creators bring brands
5. **Agency partnerships** — white-label for 20% rev share

### 8.3 Success metrics (quarterly)

| Quarter | Target |
|---|---|
| **Q2 2026** | Phases A–B shipped; 100 GitHub stars; 50 self-host users; 10 design-partner customers |
| **Q3 2026** | Phases C–D shipped; 500 stars; 500 self-hosts; $5K MRR |
| **Q4 2026** | Phases E–F shipped; 1500 stars; 2000 self-hosts; $20K MRR; 1 Series-seed conversation |
| **Q1 2027** | Phases G–H shipped; 5K stars; $100K MRR; plugin marketplace launched |

---

## 9. Open questions / decisions needed

**Resolved (2026-04-18):**

1. ✅ **Brand direction** — **Keep "InfluenceX"**. Changing mid-pivot burns SEO goodwill; product differentiation matters more than the name.
2. ✅ **Single-tenant → multi-tenant** — **Do it in Phase A.** 3 days of upfront work saves ~2 weeks of retrofitting later. Required before any paid SaaS tier ships. See [`MULTITENANCY.md`](./MULTITENANCY.md) for the migration plan.
3. ✅ **Creator marketplace seed** — **Self-crawl.** Slower cold start (3–6 months to ≥10K vetted creators) but builds a defensible asset. Scope under Phase E; background job queue does the heavy lifting; compliance layer (robots.txt, rate limits, GDPR-friendly storage) is non-negotiable.

**Still open:**

4. **BYOK vs managed LLM** — OSS users bring their own Anthropic/OpenAI keys; SaaS users get a metered proxy. Needs a spec doc in Phase A.
5. **Browser extension?** — useful for "select text → ask Content Agent to rewrite." Candidate for Phase C or D add-on.
6. **Mobile app** — probably Phase H; until then, responsive web is the focus.
7. **AI safety stance on auto-publish** — default opt-in for first 30 days, then per-channel override.
8. **Data retention** — default 90 days on agent traces; workspace can opt in to longer retention.

---

## 10. First 4 weeks — concrete action plan

To avoid "big-bang rewrite," here's the first month's work that unlocks everything else.

### Week 1

- [ ] Create `server/agent-runtime/` skeleton with Agent + Conductor interfaces
- [ ] Add `llm` module with Anthropic adapter, token metering
- [ ] DB migrations: `agents`, `agent_runs`, `agent_traces`, `workspaces`, `workspace_members`
- [ ] Port `discovery-agent.js` to new interface as first real agent
- [ ] Add `GET /api/v2/agents` (list) and `POST /api/v2/agents/:id/run`

### Week 2

- [ ] Port `mail-agent.js` and `data-agent.js` to new interface
- [ ] Conductor MVP: accept a goal, produce a 3-step plan via Claude tool use, show in UI
- [ ] New page: "Agents" — list + run + watch event stream
- [ ] Frontend: streaming SSE client

### Week 3

- [ ] Strategy Agent first implementation (ICP interview + brand voice output)
- [ ] Content Agent — Text MVP: given topic + brand voice, produce 3 captions
- [ ] Research Agent — simple web/trend fetch, 1-pass summarize
- [ ] Content Studio page (stub)

### Week 4

- [ ] Real agent eval suite — golden outputs, diff-based regression
- [ ] Cost dashboard — per-agent, per-workspace, per-day
- [ ] Landing page facelift: "Your AI content marketing team" + demo video
- [ ] Blog post #1: "We're pivoting — here's why" (public on main site + HN/Twitter)

By end of Month 1 we should have: Conductor working, three real agents ported, three new agents live, streaming UI, and a public narrative.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **LLM cost explosion** | Per-agent budgets, aggressive caching, prompt optimization, model routing (cheap for easy, expensive for hard) |
| **Quality of agent-generated content** | Eval suite, human-in-the-loop gates by default, allow users to train brand voice |
| **API surface area balloons** | OpenAPI spec keeps us honest; contract tests between agents |
| **Existing users break on v2** | v1 endpoints frozen; shared DB; feature flags let users opt in |
| **Build-versus-buy temptation** | Be ruthless — Stripe Connect, DocuSign, Mux, etc. for commoditized infra |
| **Competitor copies us** | Open-source is the moat; we're the canonical implementation |
| **Narrowing from OSS to SaaS** | OSS edition stays first-class, paid tier is convenience (hosting, SSO, compliance, marketplace) |

---

## 12. What we won't build (at least not yet)

- **A chat bot for end consumers of our users** — scope creep
- **A CDP / data warehouse** — integrate with Segment instead
- **CRM for sales** — integrate with HubSpot/Attio, don't rebuild
- **Email service provider** — stay on Resend/SES; Mailchimp/Customer.io can plug in
- **General-purpose LLM chat interface** — we're vertical; Conductor is the chat, and it's goal-directed

---

## Appendix A: naming suggestions (if pivoting brand)

- **InfluenceX Agents** (conservative; keep existing SEO, add suffix)
- **Swarm** (memorable, evokes multi-agent)
- **Aha** (playful, but collides with AhaCreator)
- **Crew** (hints at team-of-agents)
- **Loom** (weaving channels together)
- **Orchestra** (conductor → orchestra metaphor)
- **Moxie** (brandable, short)

Recommendation: stay with **InfluenceX** through Phase D, reassess with more data at Phase E. Changing names mid-pivot burns goodwill; the product differentiation matters more than the name.

---

## Appendix B: file & folder blueprint

```
server/
  agent-runtime/
    index.ts              # main runtime entry
    agent.ts              # Agent interface + base class
    conductor.ts          # plan-and-dispatch
    cost-tracker.ts
    event-stream.ts       # SSE emitter
    registry.ts           # agent discovery + versioning
  agents/
    strategy/
    research/
    content-text/
    content-visual/
    content-video/
    discovery/            # migrated from root-level discovery-agent
    outreach/             # migrated from mail-agent
    publisher/
    ads/
    community/
    analytics/            # migrated from data-agent
    brand-safety/
  llm/
    index.ts
    providers/
      anthropic.ts
      openai.ts
      local.ts            # Ollama/LM Studio
    budget.ts
    cache.ts              # prompt-level caching
  integrations/
    youtube/
    tiktok/
    instagram/
    linkedin/
    meta-ads/
    google-ads/
    tiktok-ads/
    docusign/
    stripe-connect/
  workspaces/             # multi-tenant primitives
client/
  src/
    pages/
      Strategy/
      ContentStudio/
      Calendar/
      Creators/           # renamed from KolDatabase
      Publisher/
      Ads/
      Community/
      Analytics/
      Agents/             # new — list + inspect agents
    agent-ui/
      ConductorChat.tsx
      AgentRunTrace.tsx
      CostMeter.tsx
    workspace-switcher/
docs/
  ROADMAP.md              # this file
  ARCHITECTURE.md         # runtime internals
  AGENT_SPEC.md           # how to write an agent
  PRICING.md
  MIGRATIONS.md           # v1→v2 upgrade guide
```

---

*Last updated: 2026-04-18. This is a living document — amend as we learn.*
