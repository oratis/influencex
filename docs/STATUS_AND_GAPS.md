# InfluenceX · 代码现状与设计目标差距盘点

**Last reviewed:** 2026-04-22
**Branch:** `main` · **Ahead of origin:** 2 commits (未推送)
**Scope:** 对照 [`ROADMAP.md`](./ROADMAP.md) 八阶段方案，盘点当前代码、GitHub 同步、以及距 v2.0 目标的缺口。

---

## 0. TL;DR

- Phase A (Agent runtime + 多租户) 与 Phase B (内容生成 Agents) 基本完成，并**超出路线图**额外交付了 SEO / Competitor Monitor / Review Miner / KOL-Outreach / Content-Voice 等 Agent 以及 Gemini / OpenAI / Anthropic 三线 LLM 抽象。
- Phase C (Publisher) 完成约 40%：已有 8 个平台的 Intent URL + X/LinkedIn OAuth + Medium/Ghost/WordPress 直发；但 YouTube / TikTok / Instagram / Threads 的 OAuth 连接器、调度发布后台进程、审批工作流、Translate Agent 仍缺失。
- Phase D / G 基本未启动（Ads、Community 均无 Agent）；Phase E 仍停留在旧版 KOL 发现/外联，未进入 Marketplace / Match / Negotiation / Escrow。
- **阻塞问题**：`npm test` 因 migration `2026-04-19-sso-billing-blog` 在 SQLite 下使用了 `ALTER COLUMN ... DROP NOT NULL`（SQLite 不支持）而**全量失败** — 这破坏了 CI 护栏，需要优先修复。
- **同步状态**：本地领先 origin/main **2 个 commit**（Google SSO+Stripe+blog publishers+calendar；real-data grounding+Conductor 并行）— 尚未 `git push`。GitHub 最近 push 时间为 2026-04-18。

---

## 1. GitHub 同步状态

| 项 | 值 |
|---|---|
| 远程 | `https://github.com/oratis/influencex.git` |
| 默认分支 | `main` |
| origin HEAD | `ec8a9e3` (2026-04-18) |
| 本地 HEAD | `e84f4c3` |
| 落后 | 0 |
| 领先 | **2 commits 未推送** |
| 工作区 | clean |

未推送的两个 commit：

```
e84f4c3 feat: Google SSO + Stripe billing + blog publishers + content calendar
7ae93ef feat: real data grounding (SerpAPI/web-fetch) + Conductor parallel execution
```

> **建议**：先修复测试失败（见 §4.1），再整体推送；否则远程 CI 会亮红。

---

## 2. 路线图完成度矩阵

图例：✅ 完成 · 🟡 部分 · ❌ 未动 · ➕ 额外交付

| 阶段 | 目标 | 状态 | 落地证据 / 缺口 |
|---|---|---|---|
| **A · Agent 框架基础** | runtime、Conductor、LLM 抽象、trace 存储、eval 框架、旧模块迁入 | ✅ | `server/agent-runtime/{index,conductor,eval-harness}.js`；`server/llm/index.js` (381 行，Anthropic+OpenAI+Gemini+Volcengine)；迁移 `2026-04-19-agent-runtime-tables`；`agent-runtime.test.js`、`llm.test.js` 存在。**缺**：OpenTelemetry；BYOK vs 托管代理 spec。 |
| **A.多租户** | workspaces / workspace_members，30+ 查询加 scope | ✅ | `server/workspace-middleware.js`、`server/rbac.js`、`workspace-isolation.test.js`、`workspace-scope.test.js`。迁移 `2026-04-18-multitenancy-init` 已写。 |
| **B · 内容生成 Agents** | Strategy / Research / Content-Text / Content-Visual / Content-Video + Content Studio | ✅ | `server/agents-v2/{strategy,research,content-text,content-visual,content-video,content-voice}.js`；前端 `ContentStudio.jsx`；品牌语音表 `brand_voices`；多 provider。 |
| **B ➕ 额外 Agents** | — | ➕ | `seo.js`、`competitor-monitor.js`、`review-miner.js`、`kol-outreach.js`、`content-voice.js` — 超出路线图。 |
| **C · 多渠道 Publisher** | YouTube / TikTok / IG / X / LinkedIn / FB / Threads / Pinterest / Reddit 直发 + 日历 + 审批 + 翻译 | 🟡 | `publisher.js` 做 Intent URL（8 平台）；`publish/oauth.js` 仅实现 **X + LinkedIn** OAuth 与 **Medium / Ghost / WordPress** API-Key 直发；`CalendarPage.jsx` 存在；`scheduled-publish.js` 独立 tick（60s）已在 2026-04-22 接通 direct 模式。**缺**：YouTube / TikTok / Instagram / Threads / Facebook Graph / Pinterest / Weibo OAuth；审批工作流（Editor→Approver→Publisher）；Translate Agent；本地化调优。 |
| **D · 付费广告编排** | Meta / Google / TikTok / LinkedIn Ads + Budget Optimizer + 创意生成 + 归因 | ❌ | **完全未启动**。无 `ads-agent`，无广告连接器。 |
| **E · 创作者 v2** | Creator Marketplace、Match / Negotiation Agent、DocuSign、Stripe Connect Escrow、Creator Portal | 🟡 | 沿用 v1 的 `agents/discovery-agent.js` + `kol-outreach.js`；`kol_database`、`campaigns`、`contacts` 链路存在。**缺**：Marketplace 种子数据、Match Agent、Negotiation Agent、DocuSign/Dropbox Sign、Stripe Connect、creators.influencexes.com 独立前端、创作者侧登录。 |
| **F · 分析 & 优化** | Analytics Agent、多触点归因、优化建议、A/B 框架 | 🟡 | `AnalyticsPage.jsx`、`RoiDashboard.jsx`、`roi-dashboard.js`、`ga4.js`。**缺**：Analytics Agent（目前是 `data-agent.js` 旧版）、归因引擎、Kill/Double-down 建议回路、A/B 测试框架、统一跨渠道 ROI 仪表盘。 |
| **G · 社区 & 客户环** | 跨平台统一收件箱、自动分诊、Review mining、CRM lite、Intercom/Zendesk | ❌ | 仅有 `review-miner.js` 贡献了路线图第 3 项的一部分。**缺**：unified inbox、DM/comments 拉取、自动回复草稿、VIP CRM、外部工单集成。 |
| **H · 平台与规模化** | 多工作区、Stripe 计量计费、Plugin API、白标、SSO (Okta/Azure/AD)、SOC 2、自助引导 | 🟡 | 多工作区完成；Google SSO 完成；Stripe Checkout + Portal + Webhook 存在 (`server/billing.js`)；Billing 页面已接入。**缺**：按 Token / API-call 的 usage-based metering（目前只追踪 cost）、Plugin API、白标、Okta/Azure AD、SOC 2 控制项、onboarding 引导。 |

---

## 3. 技术栈演进对照（Roadmap §7.1）

| 计划引入 | 阶段 | 现状 |
|---|---|---|
| Anthropic + OpenAI SDK、SSE | A | ✅ 已实装（并加了 Gemini / Volcengine） |
| OpenTelemetry | A | ❌ 未集成 |
| Image 模型 (DALL-E / Replicate / Stability) | B | 🟡 使用火山 Doubao Seedream；未接 OpenAI / Replicate |
| pgvector | B | ❌ `brand_voices` 无向量列；相似度仍靠字符串 |
| OAuth for 8+ social | C | 🟡 只有 2 个社交 + 3 个 blog |
| BullMQ + Redis | C | ❌ 仍是 `server/job-queue.js` 内存版 |
| Meta/Google/TikTok Ads API | D | ❌ |
| Stripe Connect / DocuSign | E | ❌ (有 Stripe 订阅；无 Connect) |
| ClickHouse / TimescaleDB | F | ❌ 仍用 SQLite/Postgres |
| WebSocket gateway | G | ❌ 仅 SSE |
| Stripe Billing | H | ✅ |
| Auth0 / WorkOS SSO | H | ❌ (仅 Google) |

---

## 4. 质量与运行时风险

### 4.1 测试失败（高优）

`npm test` **不通过**。根因：

```
server/migrations.js:475  Migration 2026-04-19-sso-billing-blog failed:
  near "ALTER": syntax error
```

问题点在 [server/migrations.js:159](../server/migrations.js:159)：

```js
'ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL'
```

SQLite 不支持 `ALTER COLUMN ... DROP NOT NULL`。当前 `catch` 仅匹配 `/duplicate|already exists|does not exist|not null constraint/i`，`syntax error` 未被吞掉。

**建议修复**：捕获 `/syntax error|near "ALTER"/i`（SQLite 分支明确忽略），或检测 `usePostgres` 再决定是否执行该语句。`llm.test.js`、`agent-runtime.test.js`、`rbac.test.js` 等被迁移失败连带挂掉，恢复后才能重新跑绿。

### 4.2 数据层迁移到 Postgres (来自 auto-memory)

- 已创建 Cloud SQL PG15 实例；代码侧 `server/database.js` 有双轨（SQLite + pg）逻辑，但 `migrations.js` 中若干语句仍是 SQLite 方言（ALTER 限制、`TIMESTAMP DEFAULT CURRENT_TIMESTAMP` 等），切到 Postgres 前需要逐条审计迁移语句。

### 4.3 上下游一致性

- ~~`server/agents`（v1）与 `server/agents-v2` 双目录并存~~ — 已在 2026-04-22 清理：`mail-agent.js` → `server/email.js`；`discovery-agent.js` → `server/youtube-discovery.js`；`data-agent.js` → `server/content-metrics.js`；`server/agents/` 目录删除。
- `publisher` Agent v1 仅生成 Intent URL；直发逻辑在 `server/publish/oauth.js`，与 Agent 未完全收敛为「一个 Agent 两种模式」（路线图原计划）。

---

## 5. 重点缺口清单（按优先级）

1. **修 migration 错误**，恢复 CI 护栏（§4.1）。
2. **推送未同步的 2 个 commit** 到 GitHub origin/main。
3. **Publisher Agent v2**：把直发收敛进 Agent 接口，补 YouTube / TikTok / Instagram / Threads / Facebook OAuth；把 `scheduled_posts` 接进 `scheduler.js` 真正定时发。
4. **Translate Agent**（Phase C 承诺）：内容 localize 12+ 语言。
5. **Ads Agent MVP**（Phase D 起步）：至少 Meta Ads + Google Ads + 统一 UTMs/归因表，即便最初只在 dashboard 聚合。
6. **Analytics Agent**（Phase F）：把 `data-agent.js` 迁到 v2，产出周报 + Kill/Double-down 建议。
7. **Community Agent MVP**（Phase G）：先对接 X + LinkedIn comment/DM 抓取 + 草稿回复；统一 inbox 表结构。
8. **数据层收尾**：pgvector 引入（品牌语音 embedding）、Redis/BullMQ 替换 in-process 队列、OpenTelemetry trace。
9. **Plugin API spec**（Phase H 依赖）、**Usage metering** 精确到 tokens / API calls，而非仅 usdCents。
10. **Creator Marketplace 种子工程** — 需求明确（自爬方案已在 Roadmap §9 敲定），但尚无代码。

---

## 6. 数据模型实际 vs 计划对齐

已存在 (migrations.js 已落):
`workspaces`、`workspace_members`、`subscriptions`、`agents`、`agent_runs`、`agent_traces`、`content_pieces`、`brand_voices`、`scheduled_posts`、`platform_connections` / `prompts` 等。

计划中尚未建表:
- `content_variants` (A/B 分组列)
- `channel_connections` 与当前 `platform_connections` 命名/语义是否等价需要明确（文档仍用两种名）
- `attribution_events` / `optimization_suggestions`（Phase F）
- `inbox_messages` / `vip_contacts`（Phase G）
- `plugins` / `plugin_installations`（Phase H）

---

## 7. 前端页面覆盖 vs Roadmap §Appendix B

路线图规划页面 vs 现状 (`client/src/pages/`)：

| 计划页面 | 当前文件 | 状态 |
|---|---|---|
| Strategy | — | ❌ 未建（逻辑放在 Conductor / Agents 页） |
| ContentStudio | `ContentStudio.jsx` | ✅ |
| Calendar | `CalendarPage.jsx` | ✅ |
| Creators (原 KolDatabase) | `KolDatabase.jsx` | 🟡 未改名 |
| Publisher | — | ❌ 功能并入 Connections / Calendar |
| Ads | — | ❌ |
| Community | — | ❌ |
| Analytics | `AnalyticsPage.jsx` | ✅ |
| Agents | `AgentsPage.jsx` | ✅ |
| Conductor | `ConductorPage.jsx` | ✅ |
| Billing | `BillingPage.jsx` | ✅ |
| Connections | `ConnectionsPage.jsx` | ✅ |
| Workspace Settings | `WorkspaceSettingsPage.jsx` | ✅ |
| Landing | `LandingPage.jsx` | ✅ |
| RoiDashboard | `RoiDashboard.jsx` | ✅（旧版保留）|
| Users | `UsersPage.jsx` | ✅ |
| Pipeline / Contacts / Data | `PipelinePage.jsx` / `ContactModule.jsx` / `DataModule.jsx` | ✅ (v1 延续) |

---

## 8. 近期行动建议（下一个 2-week sprint）

- [x] **D0**：修复 `2026-04-19-sso-billing-blog` 迁移语法（SQLite 分支跳过 `ALTER COLUMN ... DROP NOT NULL`），`npm test` 133/133 通过。
- [ ] **D0**：`git push` 本地 commit 到 origin。
- [x] **D1**：`server/agents/` 三个 v1 helper 迁出（`email.js` / `youtube-discovery.js` / `content-metrics.js`），`agents/` 目录删除。
- [x] **D2**：`scheduled-publish.js` 抽出（60s tick 已由 index.js 内联改为独立模块），并补齐 `mode='direct'` 路径 —— 用 `platform_connections` 里的 token 直接调 `publishOauth.publishDirect` 发 X/LinkedIn/Medium/Ghost/WordPress；新增 5 个单测覆盖 direct / intent / 连接缺失 / 全败 / 空队列。
- [ ] **D3**：新增 YouTube 或 Instagram 中的 **一个** OAuth 连接器作为 Phase C 的第二波落地。
- [ ] **D5**：为 `brand_voices` 引入 pgvector（Cloud SQL 已就绪）列 + 相似度检索，给 Content-Text Agent 用。
- [ ] **D7**：Ads Agent scaffold（读取 env；先不发真实广告，出结构化计划）。
- [ ] **D10**：Community Agent scaffold（从 X API 拉 mentions，写入 `inbox_messages` 新表）。

---

*This is a point-in-time snapshot. 路线图本身是活文档；出现偏差时应同步更新 `ROADMAP.md`。*
