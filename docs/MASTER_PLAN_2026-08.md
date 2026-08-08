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

## 4. 止血之后：Q2 roadmap 续推（本计划不实施，仅排序）

1. **B3 完整版** — Conductor plan SSE 推流（"正在分析受众→生成 plan"），替代 3s 轮询
2. **D5 完整版** — workspace×agent×月 usage 账目 API + Analytics 页表格（为分级计费打底）
3. **D1 Ads 真实下单** — Meta Sandbox 草稿先行（5 天，roadmap 原案）
4. **D2 Creator Marketplace 种子** — `creators_public` + 100 KOL 导入 + `/marketplace` 页
5. **Hunter 扩展**（memory.md Bug #10 遗留）— 无外链 KOL 的 Email-Finder 付费路径评估
6. **MULTITENANCY.md 收口** — 全表 `workspace_id` SET NOT NULL migration（PR-B 合并且数据回填核查后执行；这是防止 P0-3 类问题复发的结构性根治）
7. **ContactModule/PipelinePage UI 合并评估**（memory.md 已知项，Sprint 3 原案）

---

## 5. 完成定义

- [ ] PR-0～PR-D 全部合入 main，CI 绿
- [ ] 生产部署一次，冒烟：登录 / approve 发送 / ROI 页 / 邀请弹窗四点通过
- [ ] E2E_REVIEW 中所有 P0/P1 条目在文档中标记 ✅ 已修
- [ ] memory.md §6 已知 bug 表同步更新
- [ ] PR-E/PR-F 开出（允许跨周合入）

**Owner:** Claude Code 会话推进，决策默认按本计划执行；偏离计划的产品级决定（如 RBAC 收口影响现有用户权限）单独列出请人工确认。
