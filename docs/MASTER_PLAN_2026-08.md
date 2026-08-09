# InfluenceX 大型推进计划 · 2026-08

**基于:** [E2E_REVIEW_2026-08.md](./E2E_REVIEW_2026-08.md)（全局 e2e review，HEAD `ce5977a`）
**整合:** 本次 review 全部发现 + `ROADMAP_2026-Q2.md` 未完成卡片 + `memory.md` §6 已知 bug 清单
**执行方式:** 按 PR 批次推进，每批独立可合、全绿才并（`npm test` + client build + 涉及页面手测）

---

## 0. 现状一句话

平台功能面已经很宽（发现→建联→内容→发布→复盘 + 18 agents + 双语 + 移动端），但**深水区有裂缝**：两条核心 API 在特定环境必 500、pipeline 产出的数据掉进无主黑洞、多租户隔离有 6 处漏点、CI 从 5 月起一直红。本计划先止血（PR-A/B/C/D），再补护栏（PR-E），最后续推 Q2 roadmap 剩余项（§4）。

---

## 1. Q2 Roadmap 完成度盘点（TODO 审计）

| 卡片 | 状态 | 备注 |
|---|---|---|
| A1 Sentry | ✅ 完成 | `891f209` |
| A2 OTel | ✅ 完成 | `8f00ad1`（依赖冲突留下 DX-1 后遗症 → PR-A 收尾） |
| A3 BullMQ | ⚠️ 半成品 | 模块在但 API 不兼容，Redis 模式下会崩进程 → **PR-C** |
| A4 Redis cache/rate-limit | ✅ 完成 | `b15201e` |
| A5 /metrics | ✅ 完成 | `98a0d2d`（BullMQ 模式下队列指标归零 bug → PR-C） |
| B1 邀请邮件自动化 | ✅ 完成 | `98a0d2d` |
| B2 A/B winner UI | ✅ 完成 | `4619956` |
| B3 Conductor 进度 SSE | ⚠️ 半成品 | agent 流有 SSE，Conductor 计划页仍是 3s 轮询且错误静默 → PR-D 修错误可见性；SSE 化列入 §4 |
| B4 Hunter Email-Finder | ✅ 完成 | `4619956` |
| B5 EMAIL_EXISTS 文案 | ✅ 完成 | `98a0d2d`（但邀请弹窗 i18n 裸 key 回归 → PR-D） |
| C1 Playwright 冒烟 | ❌ 未启动 | → **PR-E** |
| C2 前端组件单测 | ⚠️ 起步 | 4 个组件测试文件；关键页面 0 覆盖 → PR-E 扩 |
| C3 后端集成测试 | ⚠️ 部分 | 377 单测很强，但 discovery→pipeline→send 端到端链路测试缺失（P0-1 能存活至今就是证据）→ **PR-A 补最小版**，PR-E 扩 |
| C4 CI 红线 | ❌ 且 CI 本身红 | `npm ci` 缺 `--legacy-peer-deps`，5 月起每次 push 都 fail → **PR-A** |
| C5 FormField a11y 重构 | ⚠️ 部分 | FormField 组件优秀，但 Ads / Translate / Calendar 等页未迁移（原生白底控件）→ PR-F |
| D1 Ads 真实下单 | ❌ 未启动 | 仍是离线 planner → §4 |
| D2 Marketplace 种子 | ❌ 未启动 | → §4 |
| D3 pgvector wiring | ✅ 完成 | `4619956` |
| D4 Plugin API spec | ✅ 完成 | `docs/PLUGIN_API_v0.md` |
| D5 Token metering | ⚠️ 部分 | 全局 token/cost 有；按 workspace×agent×月的账目视图缺 → §4 |

代码内 TODO/FIXME 注释：**0 个**（工程卫生很好，所有欠账都在文档里——现在也都在本计划里）。

---

## 2. PR 批次（止血序列，按此顺序执行）

### PR-0 · docs: 本次 review + 推进计划入库
`docs/E2E_REVIEW_2026-08.md` + 本文件 + CLAUDE.md/memory.md 漂移修正（377 测试、6460 行、Sentry/OTel 已接、移除不存在的 `POST /api/invitations` 引用）。
**验收:** 纯文档，无代码变更。

### PR-A · fix: P0 断裂 + 开发环境解锁 + CI 转绿
| 项 | 内容 |
|---|---|
| A-1 | approve 端点去掉幻影列 `contacts.kol_email`（收件人以 `pipeline_jobs.email_to` 为准）；Cmd-K 联系人搜索改 join `kols` 取邮箱、排序改 `created_at` |
| A-2 | `roi-dashboard.js` 时间线 CTE 的 cutoff 改为 JS 计算 ISO 参数（两方言通吃） |
| A-3 | `runPipeline` 的 `kol_database` INSERT 补 `workspace_id`，去重键改 `(workspace_id, platform, username)` 语义 |
| A-4 | 仓库根 `.npmrc`（`legacy-peer-deps=true`）→ 全新 clone `npm install` 可用 |
| A-5 | `ci.yml` 两处 `npm ci` 加 `--legacy-peer-deps` → CI 转绿 |
| A-6 | `.claude/launch.json` `runtimeExecutable` 改 `"node"`（去硬编码路径） |
| A-7 | 新增回归测试：approve 真实执行 UPDATE、ROI 时间线双方言、runPipeline 产物带 workspace_id |
**验收:** `npm test` 全绿（含新测试）；GitHub Actions 转绿；本地 approve 流程手测通过。

### PR-B · fix(security): 多租户隔离 + 邀请制收口
| 项 | 内容 |
|---|---|
| B-1 | `/api/discovery/batch-email`：kol_database 查询/写入全部 workspace 域内化，禁止跨租户 REPLACE |
| B-2 | `/api/data/*` 全家族接 `scoped()`，INSERT 补 `workspace_id` |
| B-3 | `/api/stats` 移出 skip 列表并按 workspace 统计 |
| B-4 | SSE run 流：服务端加载 run 后校验 `findMembership(run.workspace_id, user.id)`，不再信任 query 参数 |
| B-5 | Google SSO：新用户路径必须命中未过期邀请/邀请码，否则拒绝；合并账号前校验 `email_verified` |
| B-6 | `app.set('trust proxy', 1)` + 限流按真实 client IP |
| B-7 | 生产环境 webhook secret 未配置时拒绝处理（fail-closed），dev 保持宽松并告警 |
| B-8 | 新增隔离回归测试（batch-email 跨租户、/api/data 域内化、SSE 越权） |
**验收:** 测试全绿；用两个 workspace 手测 batch-email / data 接口互不可见。

### PR-C · fix(queue): BullMQ 兼容 + 发送幂等 + 进程兜底
| 项 | 内容 |
|---|---|
| C-1 | 全局 `process.on('unhandledRejection'/'uncaughtException')` → Sentry + 日志，不裸崩 |
| C-2 | BullMQ `push`/`getStats` 调用方全部 async 化（或包一层同步兼容 shim）；两个 stats 接口 + /metrics 修复 |
| C-3 | `email-jobs`：发送前原子抢占（条件 UPDATE + rowCount），杜绝重复外联 |
| C-4 | follow-up 入队标记 `follow_up_pending`，tick 重扫不重复入队 |
| C-5 | `scheduled-publish` 领取加 `AND status='pending'` 守卫 |
| C-6 | `/batch-send` 挂 workspace 限流器并真实消费配额 |
**验收:** 测试全绿；`REDIS_URL` 开/关两模式冒烟（push 返回值、stats、断 Redis 不崩进程）。

### PR-D · fix(client): 高频用户可见 bug 一次清
| 项 | 内容 |
|---|---|
| D-1 | 补 6 个 `workspace.*` 邀请弹窗 key（EN+ZH，从废弃 `workspace_settings.*` 迁移）+ `pipeline.*` 3 个 + `nav.*` 2 个；删除死命名空间 |
| D-2 | ConductorPage：Build plan 失败显示 toast + ErrorCard；轮询 try/catch + unmount 清理 |
| D-3 | DiscoveryPage：任务终态后复位提交按钮 |
| D-4 | KolDatabase：轮询 ref 置空修复（行不再永久卡 scraping） |
| D-5 | ContactModule：后台刷新不再置 loading（列表不闪）；campaign 切换加序号守卫 |
| D-6 | CalendarPage / ContentStudio 排期：统一本地时区处理（复用 `toLocalInputValue`）|
| D-7 | 登录态访问 `/signup`、`/accept-invite` → 重定向首页并提示，不再 404 |
| D-8 | Landing 头部双 "Sign In" 之一改为 "Sign up with invite code" |
| D-9 | ConnectionsPage/AgentsPage/ContentStudio 的 interval/EventSource unmount 泄漏清理 |
**验收:** client build + vitest 绿；上述每项手测截图过一遍（EN+ZH 双语检查）。

### PR-E · test: 护栏补齐（roadmap C1/C3/C4 收口）
Playwright 冒烟 3 条（登录→邀请码注册→pipeline approve→状态流转）挂 CI；discovery→pipeline→contact→send 后端集成测试（mock LLM/Resend）；CI 加 client vitest job。SQLITE_BUSY 抖动治理（per-suite DB 文件）。
**验收:** CI 三 job（unit / integration / e2e）连续 5 次绿。

### PR-F · chore(security-hardening) + 设计一致性（P2/P3 批量）
SSRF 统一走 `safeFetch`（重定向后二次校验）、CSV 公式注入前缀转义、session token 哈希化、Gmail 头注入过滤、oauth_states TTL、invite-code lookup 限流、双加密模块合并、发布平台 token 加密迁移（S-9）、RBAC 按权限表铺开（S-6，viewer 只读收口）、Ads/Translate/Calendar 迁移 FormField、toast aria-live、modal 焦点管理统一、changelog 行内 markdown 渲染、`/data` 幽灵路由清理、KOL 库 EMAIL 列改名 "Outreach draft"、~23 个死 api 方法 + ~200 死 i18n key 清理。
**验收:** 分 2-3 个子 PR 合入，每个独立全绿。

---

## 2b. 执行状态（2026-08-09 更新）

**全部止血批次已合并，main 绿：server 572 测试 / client 59 测试 / Playwright 5 条 / CI 五个 job 全过。**

| 批次 | PR | 状态 |
|---|---|---|
| PR-0 文档 | [#6](https://github.com/oratis/influencex/pull/6) | ✅ 已合并 |
| PR-A P0 + CI | [#7](https://github.com/oratis/influencex/pull/7) | ✅ 已合并 |
| PR-B 多租户/安全 | [#8](https://github.com/oratis/influencex/pull/8) | ✅ 已合并 |
| PR-C 队列幂等 | [#10](https://github.com/oratis/influencex/pull/10) | ✅ 已合并 |
| PR-D 前端 bug | [#9](https://github.com/oratis/influencex/pull/9) | ✅ 已合并 |
| PR-J 结构性收口（§4-6 提前执行） | [#11](https://github.com/oratis/influencex/pull/11) | ✅ 已合并 |
| PR-E 测试护栏 | [#12](https://github.com/oratis/influencex/pull/12) | ✅ 已合并 |
| PR-F2 前端一致性 | [#13](https://github.com/oratis/influencex/pull/13) | ✅ 已合并 |
| PR-F1 服务端加固 | [#14](https://github.com/oratis/influencex/pull/14) | ✅ 已合并 |
| 追加：限流/迁移竞态 | [#15](https://github.com/oratis/influencex/pull/15) | ✅ 已合并 |

### 执行过程中新发现的缺陷（原计划里没有）

这些不是 review 时定位到的，是在实现和验证过程中撞出来的，价值不低于原清单：

| 发现 | 严重度 | 来源 | 处置 |
|---|---|---|---|
| **限流器共用一个桶** — auth/discovery/export/sendEmail 按 IP 落同一窗口，最严的那个实际管住全部；且 `consume()` 把批量预留写进了没人检查的桶 | P1 | PR-F1 实现时发现 | #15 已修，实测验证 |
| **迁移读-改-写竞态** — 两实例冷启动，输的一方 UNIQUE 冲突 → exit(1) | P1 | PR-E 写测试时发现 | #15 已修（PG advisory lock + 容忍重复记账） |
| **session 索引写进基础 schema → 已有库启动即死** | P0 | 我在真实已有库上验证 PR-F1 时发现 | #14 内修复（测试全用新库，测不出来） |
| **ErrorCard 引用不存在的 CSS token → 暗色应用里白底白字** | P1 | PR-F2 实现时发现 | #13 已修（这正是"加载失败看起来像空状态"的根因） |
| **Ads/Translate 页用了应用里不存在的 `className="input"`** | P2 | PR-F2 实现时发现 | #13 已修（原生白底控件的根因） |
| **SSE agent-run 端点在 HEAD 上根本不可达** — workspace 中间件未跳过该路径，401 早于 handler 的 query-token 鉴权 | P1 | PR-B 实现时发现 | #8 已修 |
| **无邮件服务商时 approve 的任务卡在 `stage='send'`** — dry-run 分支在同步 pipeline 前就返回 | P2 | PR-E 写测试时发现 | 未修，测试如实断言现状 |
| **YouTube API 查询串未 encodeURIComponent** | P2 | PR-F1 实现时发现 | #15 已修 |
| **`client/node_modules` 符号链接被误提交** — 指向作者机器绝对路径，check out 后砸掉真实安装（本地已触发 ELOOP） | P2 | 合并 #13 后自食其果 | #15 已修（.gitignore 去掉尾斜杠） |

### 行为变更（需要知会用户）

- **viewer 失去全部 5 个 CSV 导出**（`data.export` 归 editor+，符合文档权限模型）
- **editor 不能再取消自己创建的定时发布**（`content.delete` 归 admin，"删除类=admin"）
- 前端仍会渲染 viewer 点不动的按钮 → 会看到 403 toast。UI 侧按权限隐藏是 S-6 的客户端半边，尚未做
- **生产未配 `RESEND_WEBHOOK_SECRET`/`APIFY_WEBHOOK_SECRET` 时 webhook 将拒收**（fail-closed，#8）
- **生产未配 `MAILBOX_ENCRYPTION_KEY` 时启动即失败**（#14；CLAUDE.md 早就这么写，但此前无代码执行）

---

## 3. 依赖与节奏

```
PR-0 ──┐
PR-A ──┼── 相互独立，可并行开发（PR-A 必须最先合，因为它让 CI 转绿，
PR-B ──┤    后续 PR 才有绿色基线可言）
PR-C ──┤
PR-D ──┘
PR-E ── 依赖 PR-A（CI 绿）+ PR-D（approve 流程可走通才能写 e2e）
PR-F ── 任意时间，低风险尾部
```

生产部署节奏（沿用 memory.md §7.3）：PR-A/B 合并后**立即部署**（P0 + 安全）；C/D 随下一班车；E/F 不触发部署。

---

## 4. 止血之后：Q2 roadmap 续推

1. **B3 Conductor SSE** — 🔄 进行中（wave 2）
2. **D5 usage 账目** — 🔄 进行中（wave 2）。技术前提已确认：`agent_runs` 表已有 workspace_id/agent_id/cost_usd_cents/tokens/started_at，**无需建表，纯聚合 + UI**
3. **D2 Creator Marketplace** — 🔄 进行中（wave 2）。**范围已调整**：roadmap 原文写"导入 100 个 KOL"，但凭空生成 100 份"看起来像真人"的创作者档案等于把伪造记录当真实数据呈现给用户，不做。改为：机制照建，数据只来自本工作区真实抓取过的 KOL 公开字段（提升进目录，带来源标注），外加 ≤10 条**明确标注为示例**的数据供空实例演示
4. **D1 Ads 真实下单** — ⏸ **需人工解锁**：要 Meta/Google 广告账号与 sandbox 凭据，且涉及真实计费风险，不自行推进
5. **Hunter 扩展** — ⏸ **需人工决策**：Hunter Email-Finder 是付费 API，要先定预算
6. **MULTITENANCY.md 收口** — ✅ 已完成（[#11](https://github.com/oratis/influencex/pull/11)，提前执行）
7. **ContactModule/PipelinePage UI 合并评估** — 未启动
8. **前端按权限隐藏控件** — 新增：#14 的 RBAC 收口只做了服务端，viewer 现在会看到点不动的按钮

### 遗留的已知问题（已定位，未修）

- **无邮件服务商时 approve 卡在 `stage='send'`** — 影响所有未配 Resend/SMTP 的部署
- **DNS-rebinding SSRF** — `assertSafeUrl` 是字面主机检查，公网域名解析到内网 IP 仍可通过；需要 resolve-then-pin 派发器
- **既有明文 platform token 未回填加密** — 读时透明兼容、下次写入时加密，但不会主动清理
- **`content_daily_stats` 的全局 `UNIQUE(content_url, stat_date)`** — 跨工作区同 URL 同日的第二条快照被静默跳过（fail-closed），彻底解决需要改约束
- **design.md 与现状脱节** — §10.3 说焦点还原未实现、§12 硬编码 `FUNNEL_COLORS`、§8.3 的 modal 契约现在是组件而非约定

---

## 5. 完成定义

- [x] PR-0～PR-D 全部合入 main，CI 绿
- [x] PR-E / PR-F 合入（#12 / #13 / #14）
- [x] E2E_REVIEW 的 P0/P1 条目全部关闭（见 §2b）
- [ ] **生产部署一次**，冒烟：登录 / approve 发送 / ROI 页 / 邀请弹窗四点通过 ← **下一步，需人工执行 `./deploy.sh`**
- [ ] memory.md §6 已知 bug 表同步更新

### 部署前必读（这批改动改变了启动前置条件）

1. **`MAILBOX_ENCRYPTION_KEY` 必须已在 Secret Manager 中** —— 否则生产启动直接 fail-fast（#14 起才真正强制）
2. **`RESEND_WEBHOOK_SECRET` / `APIFY_WEBHOOK_SECRET` 未配则 webhook 拒收**（#8 fail-closed）；若当前未配，先补上再部署，否则入站回信会被拒
3. **首次部署后查 migration 日志**：`workspace_id NOT NULL` 会逐表跳过仍有孤儿行的表并打警告；用 `GET /api/admin/orphan-rows` 查清单，清理后把该 migration id 从 `schema_migrations` 删掉重跑
4. **RBAC 收口是行为变更** —— 见 §2b「行为变更」，若与实际用法不符先调整再部署

**Owner:** Claude Code 会话推进，决策默认按本计划执行；偏离计划的产品级决定（如 RBAC 收口影响现有用户权限）单独列出请人工确认。
