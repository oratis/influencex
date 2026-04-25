# InfluenceX Roadmap · 2026 Q2/Q3

**Last reviewed:** 2026-04-25
**HEAD:** `44324f9` (post-deploy revision `influencex-00049-w2x`, prod 100% traffic)
**Scope:** 6 周（3 个 sprint），从当下推进到 v0.9 → 接近 v2.0 的**生产级**门槛。

> 这份路线图是 [`ROADMAP.md`](./ROADMAP.md) 长期愿景的"近期切片"。它整合了：
> - [`STATUS_AND_GAPS.md`](./STATUS_AND_GAPS.md) 中尚未关闭的缺口
> - [`PLATFORM_AUDIT_2026-04.md`](./PLATFORM_AUDIT_2026-04.md) 中标为 DEFERRED 的项
> - [`KOL_FLOW_TEST_2026-04.md`](./KOL_FLOW_TEST_2026-04.md) 中已修复（Sprint 1+2）和延期项
> - 2026-04-25 当前代码状态扫描

---

## 0. TL;DR

**当下基本盘**：234/234 后端测试绿、邀请制走通、KOL 抓取→建联→发邮件全链路打通、Workspace 隔离修复、LLM 邮件生成上线。**生产稳定**。

**未来 6 周三大主题**：
1. **可观测性 + 多副本就绪**（让我们能放心扩 Cloud Run 实例数）
2. **创作者全旅程闭环**（discovery → outreach → 跟进 → 签约 → 内容 → 复盘）
3. **平台扩展**（Phase D Ads 真实下单、Phase E Marketplace 雏形、Plugin API spec）

**明确不做**：白标 / SOC 2 / 创作者侧独立前端 / Plugin 商店 — 这些按 ROADMAP.md 是 Phase H 后期，先把当前路径打透。

---

## 1. 当前已落地（post-`44324f9`）

按主题归类。这些不再列入待办；用作下面 Sprint 规划的起点。

### 已完成 ✅

- **多租户隔离修完最后一公里**：4 个 discovery 端点 + pipeline_jobs `workspace_id` 全部加上过滤；`hakko-q1-all` 全局 fallback 替换为 `defaultCampaignForWorkspace()`。
- **邀请制取代公开注册**：`POST /api/auth/register` 返 410；`/api/invitations/*` token 流程上线；AcceptInvitePage 落地；管理员邀请未注册邮箱时拿到一次性链接。
- **Pipeline / Contact 邮件路径合并**：approve 改走 `email.send` jobQueue；worker 反向同步 `pipeline_jobs.stage`。两套 UI 现在看的是同一份真相。
- **LLM 邮件生成**：`generateOutreachEmail` 走 `llm.complete()`，失败回落模板。5 个调用点全 await。
- **错误状态可见性**：ErrorBoundary + ErrorCard 组件；3 个核心页（RoiDashboard / ContactModule / PipelinePage）的加载失败有明确提示 + 重试；轮询自适应退避（5s → 60s）；429 友好提示。
- **生产部署成熟**：Secret Manager 接入（36 个 secret）、`migrate-env-to-secret.sh` 一键迁移、deploy.sh 保留所有非敏感 env。当前生产 revision **00049-w2x**。
- **Sidebar / 图标按钮 a11y 标签**、**i18n EN/ZH 5 批完整覆盖**。

### 残留小尾巴 ⚠️

- `PLATFORM_AUDIT_2026-04.md` 里 **M6 FormField 重构（WCAG 2.1 Level A）**还没做（2-3 天工作量，下面 Sprint 2 处理）。
- `STATUS_AND_GAPS.md` §5 第 8/9/10 条（pgvector wiring、Redis/BullMQ、OpenTelemetry、Plugin API spec、Marketplace 种子）全未启动。
- `KOL_FLOW_TEST_2026-04.md` 里 Hunter 扩展（Bug #10）—— 仅对"创作者有外链网站"的场景有效，无外链场景需要 Hunter Email-Finder 付费 API + 已知域名，本次未做。

---

## 2. 战略支柱

下面 4 根支柱，对应"v2.0 上线之前必须收口"的硬要求。每根支柱有 3-5 个具体卡片。

### 支柱 A · 可观测性 + 横向扩展就绪

**为什么现在做**：当前 `job-queue` / `cache` / `rate-limit` **全部是单进程内存**。Cloud Run 一旦把 `--max-instances` 调过 1，发邮件就会出现重复发送、轮询数据不一致、限流被绕过。Plus，生产没有任何 trace / Sentry，线上 Bug 等于天书。

| ID | 任务 | 价值 | 估时 |
|---|---|---|---|
| **A1** | **接 Sentry 客户端 + 服务端**（替代我们 ErrorBoundary 只 console.error） | 生产 Bug 终于看得见 | 0.5 天 |
| **A2** | **OpenTelemetry trace 接入**（agent run + 邮件发送 + 关键 API endpoint） | 看清 LLM 调用链 + 成本归因 | 1.5 天 |
| **A3** | **BullMQ + Redis 替换 in-process job queue**（保留接口兼容） | 多副本不再丢消息 | 2 天 |
| **A4** | **Redis 化 rate-limit + cache** | 多副本限流准确 + 缓存共享 | 1 天 |
| **A5** | **`/metrics` Prometheus 端点**（队列长度、Resend 错误率、agent 成本） | 接 Cloud Monitoring 看大盘 | 0.5 天 |

**总投入**：~5.5 天。出口：可以放心 `--max-instances=10`。

### 支柱 B · 用户旅程闭环

**为什么现在做**：邀请制刚上线但邀请方式仍是"管理员复制链接手动发"，体验粗糙。Pipeline → Contact 已通但中途有几个点用户会"摸不着北"。

| ID | 任务 | 估时 |
|---|---|---|
| **B1** | **邀请邮件自动化**：`POST /api/invitations` 触发后自动 Resend 模板邮件给被邀请人，admin 端只需输入邮箱不必复制链接（保留链接展示作为回退） | 0.5 天 |
| **B2** | **A/B winner 自动应用**：现已有 `ab-significance.js` 计算显著性，但前端 UI 不展示获胜文案标记 + 没有"自动启用赢家"开关 | 1 天 |
| **B3** | **Conductor plan 进度 SSE**：现在仅显示倒计时，应改成后端推送中间步骤（"正在分析受众" → "生成 plan A/B"） | 1 天 |
| **B4** | **Hunter Email-Finder 第二条路径**：当 KOL 没有外链网站但能解析出"姓 + 名 + 推断域名（如 `{username}.com`）"时，调 Hunter `email-finder`；命中率写日志，方便后续判断是否值得付费 | 1 天 |
| **B5** | **统一"未邀请用户被邀请时"的 EMAIL_EXISTS 提示页**：当前只在 AcceptInvitePage 里做了，admin 邀请已注册用户时也应该明确说"该用户已注册并直接加入" | 0.25 天 |

**总投入**：~3.75 天。出口：admin 邀请新人零摩擦；KOL 邮箱命中率 +20%；Conductor 体验从"loading...10s"变成"看到 AI 在干嘛"。

### 支柱 C · 测试 / 质量护栏

**为什么现在做**：234 个后端单元测试已经救过我们一次（rebase 时发现 email_events migration 冲突）。但前端 0 测试、0 E2E。下次大重构很可能没这么走运。

| ID | 任务 | 估时 |
|---|---|---|
| **C1** | **Playwright 冒烟测试**：登录 → 接受邀请 → 创建 campaign → 添加 KOL → 生成邮件 → 发送 → 看 status 变更。3 条用例 | 2 天 |
| **C2** | **前端组件单测（Vitest + React Testing Library）**：先覆盖 ErrorBoundary、ErrorCard、AcceptInvitePage、PipelinePage 关键交互 | 1.5 天 |
| **C3** | **后端测试补"discovery → pipeline → contact → send"端到端集成测试**（mock LLM + mock Resend） | 1 天 |
| **C4** | **CI 加 Playwright + lighthouse-ci**（performance budget + a11y 红线） | 0.5 天 |
| **C5** | **M6 表单 a11y 重构**（PLATFORM_AUDIT_2026-04 deferred）：抽 `<FormField>` 组件，Campaign / Studio / Settings 全部改造 | 2 天 |

**总投入**：~7 天。出口：再大改不再"靠 build 通过 + 手测一下"硬上。

### 支柱 D · 平台延展（按 ROADMAP.md Phase D/E/H）

**为什么现在做**：现在邀请制 + KOL 全闭环已稳，是时候把 ROADMAP §3 里挂了的 D/E 几个 Agent 落到"能下单"的程度。

| ID | 任务 | 估时 |
|---|---|---|
| **D1** | **Ads Agent 接真 API**（之前是离线 plan）：先做 Meta Ads `POST /act_<id>/campaigns` + Google Ads SearchAds 360；至少能下"草稿广告"（不直接 publish） | 5 天 |
| **D2** | **Creator Marketplace 种子**：新建 `creators_public` 表 + 一个静态导入 100 个 KOL 的 seed 脚本；前端 `/marketplace` 页让用户从"自爬库"选人加 campaign | 2 天 |
| **D3** | **pgvector wiring**：`brand_voices.embedding` 已建索引但代码没用；接到内容生成 agent 上做"找最相似的语调"，content-text agent 受益最大 | 1.5 天 |
| **D4** | **Plugin API spec v0**：写一份 markdown spec（不实施），固定 hook 接口。不开放给外部，但用来重构 agents-v2 → agents-v3 减少耦合 | 1 天 |
| **D5** | **Token-based usage metering**：现有 stats 只追踪 `usdCents`，要细化到每个 workspace 每个 agent 每月调用次数 + token 数；为后续按 token 阶梯计费打底 | 1 天 |

**总投入**：~10.5 天。

---

## 3. Sprint 切分

### Sprint 1 — Stabilize & Observe（2 周）

**目标**：上 Sentry + OTEL + BullMQ；接受邀请变邮件触发；修 a11y。

| 周 | 卡片 |
|---|---|
| 1 | A1 Sentry · A5 metrics · B1 邀请邮件 · B5 EMAIL_EXISTS 文案 · C1 Playwright 3 条 |
| 2 | A3 BullMQ · A4 Redis cache/rate-limit · A2 OpenTelemetry · C5 FormField 重构（开始）|

**Sprint 1 退出条件**：
- Sentry 跑 1 周积累 errors，回归看常见 Top-5 是否在审计 doc 里被覆盖
- Playwright 在 GitHub Actions 上稳定跑过 5 次
- BullMQ + Redis 在 prod 跑通"管理员发起 1000 封邮件 + Cloud Run scale 到 3 实例不丢消息"

### Sprint 2 — Close the Loop（2 周）

**目标**：A/B winner 自动应用 + Hunter Email-Finder + Conductor SSE；C5 完工；Marketplace 雏形。

| 周 | 卡片 |
|---|---|
| 3 | B2 A/B winner UI · B3 Conductor SSE · B4 Hunter Email-Finder · D3 pgvector wiring |
| 4 | C2 前端组件单测 · C3 集成测试 · D2 Creator Marketplace 种子 |

**退出条件**：邀请→KOL→邮件→A/B 跑赢→广告创意 4 步全部 SSE 实时反馈；Marketplace 至少 100 创作者可选。

### Sprint 3 — Ads & Metering（2 周）

**目标**：Ads Agent 真实下单（草稿）+ Plugin API spec + token metering。

| 周 | 卡片 |
|---|---|
| 5 | D1 Meta Ads 真实集成（Sandbox） · D5 token metering 上线 · C4 CI 红线 |
| 6 | D1 Google Ads · D4 Plugin API spec v0 · 整体回归测试 |

**退出条件**：能在 prod 创建 1 条 Meta 广告草稿（人工 publish）、1 条 Google Ads 草稿；usage metering 能按 workspace 出账目；Plugin spec 文档评审过。

---

## 4. 明确不做（拒绝列表）

按重要性排序，理由必须明确：

| 项 | 为什么先不做 |
|---|---|
| **白标 / 自定义 domain** | 还没积累足够的付费客户来论证投入产出 |
| **SOC 2 Type 2** | 9-12 个月工程；客户 demand 还没到。先做 SOC 2 Type 1 self-attestation |
| **Creator 侧独立前端 (creators.influencexes.com)** | 当前邀请方一定是品牌方，创作者只在邮件里收到链接，不需要独立面板 |
| **Stripe Connect / Escrow** | 需要金融合规审查，且当前 KOL 数据规模还撑不起来 |
| **Plugin 公开商店** | Plugin spec 先做内部用，开放生态等到 Sprint 3 之后 |
| **多 LLM 横向 benchmark UI** | `llm/index.js` 已经支持 3 provider 切换，不需要 UI 暴露这个复杂度给用户 |
| **CRM lite (HubSpot 替代)** | 我们不卖 CRM；contacts 表足够支撑当前 outreach loop |

---

## 5. 风险与早期信号

| 风险 | 早期信号 | 应对 |
|---|---|---|
| BullMQ 引入引发回归 | Redis 连接抖动 / 旧 jobQueue API 不兼容 | A3 卡片做 1 周 dual-write 验证（旧 + 新都跑） |
| Sentry/OTEL 拖慢 cold start | Cloud Run 启动时间 > 5s | 监控启动耗时，Sentry init 改成 lazy |
| Hunter Email-Finder 命中率太低 | 50 次调用命中 < 5 | 可以仅在 admin 手动触发时调；不进发现自动流 |
| Ads Agent 下单出错产生真实费用 | 任意 unexpected charge | D1 全程在 Sandbox + Test Account；prod 上线前必须人工 review 1 条 |
| Marketplace 种子数据合规 | 任意 KOL 起诉 | 仅存公开数据 (channel name + followers + URL)，不存 email；标注数据来源 |

---

## 6. v2.0 完工定义（DoD）

发布 v2.0 时需同时满足：

1. **稳定**：Cloud Run `--max-instances=10` 跑 1 周无 P0 故障
2. **可观测**：Sentry / OTEL / Prometheus 三件套接通 + dashboard 公开
3. **测试**：234 个后端测试 + 至少 5 条 Playwright + 20 个前端组件测试，CI 全绿
4. **闭环**：从邀请用户到发出第 100 封邮件 + 看到 A/B 获胜数据，无人工干预
5. **平台**：Ads Agent 至少能在 Meta Sandbox 跑通；Marketplace 至少 500 创作者
6. **文档**：本 roadmap、ROADMAP.md、STATUS_AND_GAPS.md 同步到当下；admin 操作手册写完

满足以上即可标记 v2.0，开放公开邀请。

---

## 7. 附：本路线图与既有文档的关系

| 文档 | 关系 |
|---|---|
| [ROADMAP.md](./ROADMAP.md) | **长期愿景** — 8 阶段（A-H）、agent 架构图、商业模型。本 doc 是它的"近期切片"+ Q2 推进 |
| [STATUS_AND_GAPS.md](./STATUS_AND_GAPS.md) | **历史状态盘点**（2026-04-22）— 本 doc 接续它的 §5 缺口清单；STATUS_AND_GAPS 不再更新，未来 review 走本 doc |
| [PLATFORM_AUDIT_2026-04.md](./PLATFORM_AUDIT_2026-04.md) | **UX/可用性审计** — 本 doc 把它的 DEFERRED 项（M6/L5/X1/X2/X3）整合进 Sprint 计划 |
| [KOL_FLOW_TEST_2026-04.md](./KOL_FLOW_TEST_2026-04.md) | **E2E 测试报告** — 已被 commit `7c825d7` + `44324f9` 关闭绝大部分；剩 Hunter 扩展进入 B4 |
| [MULTITENANCY.md](./MULTITENANCY.md) | **架构参考** — 本 doc 不修改，作为新 agent 接入时的契约 |
| [USER_GUIDE.md](./USER_GUIDE.md) | **用户文档** — Sprint 3 末尾会同步更新 |

---

**下次 review 节点**：Sprint 1 结束（2 周后）。届时更新本 doc 标记完成项 + 调整 Sprint 2/3 优先级。
