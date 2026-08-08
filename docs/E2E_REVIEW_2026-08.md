# InfluenceX 全局 E2E Review · 2026-08-08

**HEAD:** `ce5977a`（main）
**方法:** ① 全新 clone → `npm install` → `npm test` → client build；② 本地 SQLite + seed 数据，浏览器实测 22 条路由全走查（登录/注册/邀请码/Discovery/Pipeline/Contacts/Conductor/Settings/ZH 双语/移动端）；③ 服务端 + 客户端静态代码审计（多租户 / 安全 / 队列 / i18n / 轮询 / a11y），关键结论均已在真实代码或运行环境二次验证。
**结论 TL;DR:** 平台整体质量高于 4 月审计时的水平（377/377 测试绿、双语覆盖完整、移动端可用、邀请闭环走通），但存在 **2 个 P0 功能性断裂**（Pipeline approve 必 500、ROI 在生产 Postgres 必 500）、**1 个 P0 数据缺陷**（pipeline 写入的 KOL 库记录无 workspace_id）、以及一批多租户/安全缺口。修复清单与执行顺序见 [MASTER_PLAN_2026-08.md](./MASTER_PLAN_2026-08.md)。

> 严重级定义 — **P0**: 核心链路断裂或数据损坏；**P1**: 高影响 bug / 安全缺口；**P2**: 明确缺陷但有绕行；**P3**: 打磨项。
> 标注 ✅ = 已在本机运行环境实际复现/验证；未标注 = 静态审计定位（可信度高，修复时按代码路径复核）。

---

## 0. 基线健康度

| 检查 | 结果 |
|---|---|
| `npm test`（服务端） | ✅ 377/377 绿（~1s）— 注意：文档写 234，实际已 377 |
| `cd client && npx vite build` | ✅ 通过，主 bundle 437KB（gzip 115KB） |
| 全新 clone 后 `npm install` | ❌ **失败**（见 DX-1） |
| `.claude/launch.json` | ❌ 写死 `/usr/local/bin/node`（见 DX-2） |
| 22 条前端路由 | ✅ 全部可达渲染，无白屏 / 控制台报错 |
| ZH 双语 | ✅ 整站覆盖（1511/1511 key 双语字典完全平行） |
| 移动端 375px | ✅ 汉堡菜单 + 响应式卡片，无横向溢出 |
| 邀请码闭环 | ✅ 生成 → /signup 校验 → 建号 → 自动登录 → 入 workspace（Editor） |

---

## 1. P0 — 核心链路断裂（必须立刻修）

### P0-1 ✅ `POST /api/pipeline/jobs/:id/approve` 引用不存在的列，每次调用必 500
`server/index.js:5174` 更新 `contacts` 时写 `kol_email=COALESCE(kol_email, ?)` — **`contacts` 表没有 `kol_email` 列**（已用 PRAGMA 实测确认；基础 schema 和所有 migration 均未添加，代码库其它地方的 `kol_email` 全是 `k.email AS kol_email` 别名）。更糟的是前一条语句已把 pipeline job 推进到 `stage='send'`，然后本条抛错 → job 卡死在 send 阶段且没有任何邮件入队。**Pipeline 的人工审批发送主链路当前是坏的。**
同类幻影列：`server/index.js:3455-3461` Cmd-K 联系人搜索 select `kol_username, kol_email` 并按不存在的 `contacts.updated_at` 排序，错误被 `.catch(() => [])` 吞掉 → 搜索联系人永远返回空。
**修复:** approve 去掉 `kol_email` 写入（收件人已存在 `pipeline_jobs.email_to`）；搜索改 join `kols` 取邮箱、排序列改 `created_at`。补一条会真正执行该 UPDATE 的测试。

### P0-2 `GET /api/campaigns/:id/roi` 在生产 Postgres 上必 500
`server/roi-dashboard.js:21,25,30` 时间线 CTE 用 SQLite 独有的 `datetime('now','-30 days')`，无 `usePostgres` 分支（已读码确认无分支）。本地 SQLite 测试全绿，但 Cloud SQL PG15 会抛 `function datetime(unknown, unknown) does not exist` → **生产 ROI 页整页挂**。
**修复:** JS 侧计算 ISO cutoff 作为参数传入（`scheduler.js:52` 已有同样做法），一处改动两方言通吃。

### P0-3 `runPipeline` 写入 `kol_database` 不带 `workspace_id`
`server/index.js:5012-5024` 两个方言分支的 INSERT 列清单都没有 `workspace_id`（已读码确认），而列是 nullable 的所以静默成功。后果：pipeline 抓取的 KOL 在 `/api/kol-database`（按 workspace 过滤）里**永远不可见**；每次 run 生成新 uuid，`ON CONFLICT (id)` 永不命中 → 无限堆积重复行。
**修复:** 列清单加 `workspace_id`（函数已收到该参数），去重键改 `(workspace_id, platform, username)`；补测试。

---

## 2. P1 — 多租户 / 安全

| # | 位置 | 问题 | 场景 |
|---|---|---|---|
| S-1 | `server/index.js:5761-5985` | `/api/discovery/batch-email` 的 kol_database 去重查询不带 workspace 过滤，且 `INSERT OR REPLACE` 复用他租户行 id 时会**整行改写并清掉对方 workspace_id**（SQLite）/ 覆盖字段（PG） | A 工作区跑 batch-email，静默改写/吞并 B 工作区同一创作者的记录 |
| S-2 | `server/index.js:2129-2214, 5239-5399` | **整个 `/api/data/*` 家族无 workspace 过滤**（content_data / registration_data / daily stats / dashboard combined 的读和写） | 任意登录用户读写所有租户的内容/注册数据 |
| S-3 | `server/auth-google.js:98-124` | **Google SSO 绕过邀请制**：callback 无邀请校验直接建号 + 自动配 workspace；且未检查 `email_verified` 就按邮箱合并账号 | 配了 GOOGLE_OAUTH 后任何 Google 账号可自助注册；未验证邮箱可被用于接管 |
| S-4 | `server/index.js:2596-2599` | SSE agent run 流的 workspace 校验由**调用方 query 参数**控制，省略 `workspace_id` 即跳过 | 拿到 runId 即可回放他租户 agent 输出 |
| S-5 | `server/index.js:1666-1698` | Resend 入站 webhook 按裸邮箱匹配 contact/pipeline，跨 workspace 不去重 | 两个租户外联同一创作者时，回信写错租户 |
| S-6 | `server/rbac.js` 使用面 | RBAC 只挂在 4 组路由上；viewer 角色可发邮件、删 campaign、改邮箱凭据 | 权限模型形同虚设（对内产品当前风险可控，开放邀请前必须收口） |
| S-7 | `server/index.js:1627,1820` | Resend / Apify webhook 签名校验在未配置 secret 时**默认放行** | 未配 secret 的部署可被伪造回信/事件 |
| S-8 | 无 `app.set('trust proxy')` | Cloudflare→Cloud Run 下 `req.ip` 是边缘节点，authLimiter 10/min 把所有真实用户揉进一个桶 | 一个攻击者可锁死全站登录 |
| S-9 | `server/index.js:2838-2903` | 发布平台 token（除 Gmail 外）与 API-key 平台凭据**明文落库** | 违反自家 MAILBOX_ENCRYPTION_KEY 约定 |
| S-10 | `server/index.js:330` | 密码重置链接 origin 取自请求头，仅靠 CORS 侧防线兜底 | 配置漂移即重开 reset-token 外带攻击面 |

P2/P3 安全杂项（SSRF 重定向绕过、CSV 公式注入、session token 明文存储、Gmail RFC822 头注入、oauth_states 不过期、invite-code lookup 无限流、双加密模块并存）详见 master plan §PR-C。

## 3. P1 — 前端

| # | 位置 | 问题 |
|---|---|---|
| C-1 ✅ | `WorkspaceSettingsPage.jsx:381-410, :89` | **邀请弹窗整个显示裸 key**（`workspace.invite_link_title` 等 6 个 key 两语言都缺；译文其实躺在废弃的 `workspace_settings.*` 命名空间里）— 已截图实锤 |
| C-2 | `KolDatabase.jsx:45-54` | 抓取轮询第一跳后死亡（cleanup 清了 interval 但没置空 ref，下次 effect 以为还在跑）→ 行卡 "scraping" 直到手动刷新 |
| C-3 | `ContactModule.jsx:57,62,231` | 5s 轮询把 `loading` 置 true → **整个列表每 5 秒闪没一次**，勾选/滚动上下文全丢 |
| C-4 ✅ | `ConductorPage.jsx` | Build plan 失败**完全静默**（无 toast 无提示；服务端明明返回了清晰的 400 文案）— 已实测复现 |
| C-5 ✅ | `DiscoveryPage.jsx` | 任务已结束但 Start discovery 按钮卡在 "Starting..." 不复位，不刷新无法再次发起 — 已实测复现 |
| C-6 ✅ | 登录态访问 `/#/signup?code=...` | 直接 404（authed 路由无 /signup），邀请链接体验断裂 — 已实测复现 |
| C-7 | `CalendarPage.jsx:17,85` | 按 UTC 日分桶 + isToday 判断 — UTC+8 用户 00:00-08:00 的事件落到前一天、"今天"高亮错位（✅ 实测看到 8/8 当天高亮在 8/9） |
| C-8 | `ContentStudio.jsx:559,124` | 排期弹窗用 `toISOString().slice(0,16)` 播种 datetime-local — UTC+8 用户默认时间是 8 小时前，且提交的本地时间串无时区语义（`ContactThreadDrawer` 已有正确实现可复用） |

P2 级前端问题（EventSource/interval 泄漏、搜索无防抖竞态、campaign 切换竞态、静默加载失败页、toast 无 aria-live、8+ 个自绘 modal 无焦点管理、`/data` 幽灵路由、Landing 双 "Sign In" 按钮 ✅、Ads/Translate 页原生白底表单控件 ✅、changelog 不渲染行内 markdown ✅、KOL 库 EMAIL 列语义歧义 ✅）详见 master plan §PR-D/§PR-F。

## 4. P1/P2 — 队列与邮件正确性

| # | 位置 | 问题 |
|---|---|---|
| Q-1 | `bullmq-queue.js` vs 调用方 | BullMQ 模式下 `push()`/`getStats()` 是 async，但**所有调用方按同步用**：返回的 jobId 是序列化的 `{}`、两个 stats 接口一个返回空一个直接 TypeError、Redis 抖动时 `setInterval` 里的裸 push 产生 unhandled rejection——而全库**没有 `process.on('unhandledRejection')`** → Node ≥15 直接进程退出，进程内队列任务全丢 |
| Q-2 | `email-jobs.js:78` | 重发防护是"读状态再行动"而非原子抢占（`UPDATE ... WHERE status='pending'` + rowCount）→ BullMQ 多副本（它存在的意义）或双击重试下**同一联系人可能收到重复外联邮件** |
| Q-3 | `scheduler.js:53-127` | follow-up 依据未变化的 `follow_up_count` 重复入队（5 分钟 tick 内未完成即双发）；多副本下 due-SELECT→UPDATE→enqueue 无串行化 |
| Q-4 | `scheduled-publish.js:69-81` | 领取任务的 UPDATE 无 `AND status='pending'` 守卫 → 多副本双发布 |
| Q-5 | `index.js:1485-1499` | `/batch-send` 只预检不消费限流票据，且没挂 workspace 限流器 → 反复小批量绕过工作区发送上限 |

## 5. DX / 运维

| # | 问题 |
|---|---|
| DX-1 ✅ | **全新 clone 后 `npm install` 装不出 `undici`**（OTel auto-instrumentations peer-dep 冲突；Dockerfile 用 `--legacy-peer-deps` 绕过但本地没有）→ `npm test` 直接 MODULE_NOT_FOUND。修复：仓库加 `.npmrc`（`legacy-peer-deps=true`）或升级 OTel 套件 |
| DX-2 ✅ | `.claude/launch.json` 写死 `/usr/local/bin/node`，Homebrew ARM 机器上 preview_start 直接起不来。改 `"node"` |
| DX-3 ✅ | 测试偶发 `SQLITE_BUSY`（首跑失败 3 个文件，重跑全绿）— 并行 test runner 争用同一 SQLite 文件，建议 per-suite 独立 DB 文件或 WAL + busy_timeout |
| DX-4 | `server/seed-demo.js` 与 `index.js` 内私有 `seedDemoData()` 双轨；后者产出的 `hakko-q1-all` campaign 无 workspace_id，对所有工作区不可见且 `POST /api/data/seed-demo` 任何登录用户可触发 |
| DX-5 | CLAUDE.md/文档漂移：写着 234 测试（实际 377）、~5100 行 index.js（实际 6460）、"无 Sentry/OTel"（都已接）、`POST /api/invitations`（路由不存在）；MULTITENANCY.md 的 NOT NULL 收紧步骤从未执行（这正是 P0-3/S-1/S-2 能静默发生的根因） |

## 6. 值得肯定的（不需要动）

- `scoped()` + 运行时 scope lint 模式扎实，`index.js` 主体路由用得正确（join 行也带 workspace 校验）
- 邀请制不变量守住了：register 410、邀请 token/重置 token 均 sha256 落库、invite-code 兑换用正确的乐观锁
- `email-jobs.js` 单一事实源设计好：终态/瞬态错误分流、pipeline 反向同步、硬弹黑名单按 workspace 隔离
- 前端 401 处理干净（深链接过期后重登还能回原页）、`FormField`/`ConfirmDialog` 是标准 a11y 实现、EN/ZH 字典 1511 key 完全平行且有 dev 缺 key 告警
- 双语、移动端、Cmd-K、onboarding、changelog 页——4 月以来的功能迭代整体质量在线

---

**全部修复项已按 PR 批次整理进 [MASTER_PLAN_2026-08.md](./MASTER_PLAN_2026-08.md)，含优先级、依赖关系与验收标准。**
