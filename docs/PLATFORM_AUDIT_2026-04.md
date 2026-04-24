# InfluenceX 平台审计 & 优化方案（2026-04-24）

> 从用户视角浏览与测试整个平台后整理出的优化清单。覆盖：运行时错误、用户体验（UX）、可访问性（a11y）、性能、部署与运维。每一条包含「现象 → 根因 → 建议方案 → 工作量估算」。

---

## 一、总体评估

- **代码结构**：整体良好。前端分页清晰（`client/src/pages/` 下 20+ 页面），后端按 feature 拆分（`server/email-jobs.js`、`server/ab-significance.js`、`server/scheduler.js`、`server/secrets.js` 等），测试覆盖主要新增模块。
- **国际化**：最近 5 批 i18n 覆盖已经很完整，客户端几乎无硬编码英文（仅剩 ~3 处，均为低优先级）。
- **真正的痛点**集中在三块：
  1. **没有 React 错误边界** → 子组件一旦抛错整颗树崩溃，浏览器控制台已经能复现。
  2. **错误/加载/空状态处理粗糙** → 多个页面在 API 挂掉时只弹 toast，然后留下空白页或无尽 spinner。
  3. **生产部署流水线**有一处真实阻塞：环境变量迁移到 Secret Manager 时 Cloud Run 拒绝「原为明文 env → 改为 secret」的原地变更，本次 `./deploy.sh` 就因此失败（build 成功，deploy 失败）。

下面按优先级排序给出可落地的动作项。

---

## 二、🔴 高优先级（阻塞或影响所有用户）

### H1. 缺少全局 Error Boundary

- **现象**：浏览器 Console 里重复出现
  ```
  The above error occurred in the <AppContent> component:
      at AppContent (src/App.jsx:378)
      ...
  Consider adding an error boundary to your tree to customize error handling behavior.
  ```
  React 本身在提示这件事。任何一个子组件（例如某个 lazy 载入的 Dashboard、某个图表组件）抛未捕获异常，就会把整个应用白屏。
- **根因**：[client/src/App.jsx](client/src/App.jsx) 的 Provider 树没有包裹 `ErrorBoundary`。
- **方案**：
  1. 新建 `client/src/components/ErrorBoundary.jsx`（class component + `componentDidCatch`），展示「发生错误，点这里重试」UI，按钮调用 `window.location.reload()` 或 reset state。
  2. 在 `App.jsx` 把 `<AppContent />` 外层包一层 `<ErrorBoundary>`。
  3. 在每个 Route 粒度再加一层（推荐用 `react-router` v6 的 `errorElement`，但当前版本是 v6，这是 `v6.4+` 的 data router 特性 —— 如果不用 data router，在 `<Suspense>` 外加 `<ErrorBoundary>` 也可以）。
  4. 错误上报：`componentDidCatch` 里可以 `fetch('/api/client-errors', {...})` 落表，方便线上排查。
- **工作量**：0.5 天（代码 2 小时 + 各页面分支测试）。

### H2. 生产部署被 env → secret 类型冲突卡住

- **现象**：本次 `./deploy.sh` 构建成功（GCR push 完成），但 `gcloud run deploy` 报：
  ```
  Cannot update environment variable [RESEND_API_KEY] to the given type
  because it has already been set with a different type.
  ```
- **根因**：`669c991 ops: move sensitive env vars to GCP Secret Manager` 把多个敏感变量从 `--update-env-vars` 迁到 `--update-secrets`，但线上 Cloud Run service 仍保留着旧的明文 env 定义。Cloud Run 不允许同名变量从 env 「原地改」为 secret 引用。
- **方案**：一次性清理，分两步（人为执行，命令在 PR/Runbook 里写死）：
  1. 枚举所有受影响的变量（见 `deploy.sh` 第 31–68 行 `SECRETS_CSV`）。
  2. 先 `gcloud run services update influencex --region=us-central1 --remove-env-vars=RESEND_API_KEY,RESEND_WEBHOOK_SECRET,ADMIN_PASSWORD,MAILBOX_ENCRYPTION_KEY,GMAIL_OAUTH_CLIENT_SECRET,...`，再重跑 `./deploy.sh`。
  3. 在 [deploy.sh](deploy.sh) 顶部加一段 comment：「线上首次从 env 迁 secret 时需先 remove-env-vars，否则 deploy 会失败」，或者干脆写一个 `scripts/migrate-env-to-secret.sh` 一键做完。
- **工作量**：30 分钟，但需要 prod 变更窗口。

### H3. 新增端点本地返回 500（Mailbox / Scheduled Publishes / Publish Platforms）

- **现象**：打开平台后浏览器 Network 面板显示：
  ```
  GET /api/publish/platforms              → 500
  GET /api/scheduled-publishes?limit=50   → 500
  GET /api/mailboxes                      → 500
  GET /api/mailboxes/oauth/gmail/status   → 500
  ```
  这些端点都来自刚 rebase 合入的 `5aff917`（KOL outreach 升级）。
- **根因候选**（按概率排序）：
  1. **migration 还没跑** → `mailbox_accounts`、`scheduled_publishes` 等新表在本地 DB 缺失，导致 SQL 报错。
  2. **加密密钥缺失** → [server/secrets.js](server/secrets.js) 读取 `MAILBOX_ENCRYPTION_KEY`，本地 `.env` 没设时解密抛错。
  3. **路由层把未处理异常映射成 500**（标准 Express 行为，但错误信息没返给客户端）。
- **方案**：
  1. 在 server 启动时 fail-fast 校验关键 env：未配置 `MAILBOX_ENCRYPTION_KEY` 时要么禁用相关路由 + 在响应里给出 `503 + { reason: 'mailbox_accounts_disabled' }`，要么在启动日志打 warn。
  2. API 路由要统一的错误中间件，把 message 透传给客户端（开发环境）、生产环境脱敏。
  3. 前端对 503/500 要降级展示：例如 Connections 页在 mailbox 接口挂掉时展示「此功能需管理员先配置加密密钥」提示卡，而不是让整页空白。
- **工作量**：1 天（含前后端联调）。

### H4. 部分页面 API 失败后只弹 toast，页面变白屏或永远 loading

- **现象**：
  - [client/src/pages/RoiDashboard.jsx:45](client/src/pages/RoiDashboard.jsx:45) 附近：`api.getCampaignRoi` 报错时只 `toast.error`，loading 被清为 false 后页面没有 fallback，用户看到空白。
  - [client/src/pages/ContactModule.jsx](client/src/pages/ContactModule.jsx) 的 `loadContacts` 失败时只 `console.error`，spinner 可能卡住。
  - [client/src/pages/PipelinePage.jsx](client/src/pages/PipelinePage.jsx) 三个 loader（`loadJobs`、`loadDiscoveryJobs`、`loadOutreachTasks`）错误直接吞掉，用户看不到数据过期的提示。
- **方案**：
  1. 所有 async loader 显式区分三态：`loading` / `error` / `ready`。错误态渲染「加载失败 + 重试按钮」组件（建议抽成 `components/ErrorCard.jsx`）。
  2. 重试按钮调用同一个 loader，不要做整页 reload。
  3. 所有轮询（polling）循环内捕获异常但**保留上一次成功数据**，同时在顶部挂一个小标签「上次更新 X 秒前（可能已过期）」。
  4. 删除 `catch (e) { /* ok */ }` 之类的静默吞异常，至少留 `logger.warn`。
- **工作量**：1.5 天（4 个大页面各 2–3 小时）。

---

## 三、🟠 中优先级（影响体验、规模）

### M1. 轮询架构：每 5s 全量轮询，多页叠加会打爆接口

- **现象**：[client/src/pages/ContactModule.jsx:46-54](client/src/pages/ContactModule.jsx:46)、[PipelinePage.jsx](client/src/pages/PipelinePage.jsx) 等多处用 `setInterval(..., 5000)` 做状态轮询。一个 workspace 同时开几个 tab、或者 contacts 表上百条时，rpm 容易撞 rate limit（本次测试里 `/contacts/batch-send` 就触发了 429）。
- **方案**（按投入递增）：
  1. **最小改动**：把 5s 改为 **自适应退避**（30s→60s→120s，用户有交互重置为 5s）。
  2. **中等改动**：抽一个 `useAutoRefresh(fn, { activePath })` hook，只有该 path 处于前台 tab 时才轮询。`document.hidden` 监听一下。
  3. **较优方案**：加 SSE（Server-Sent Events）或 WebSocket，后端在 contact/pipeline 状态变更时 push。Express 加 SSE 代价极小（一个 `res.write('data: ...\n\n')` 接口即可）。
- **工作量**：方案 1–2 半天；方案 3 2–3 天。

### M2. Rate limit 429 缺少用户可见反馈

- **现象**：浏览器 Network 里能看到 `POST /contacts/batch-send → 429`，但前端没有给用户展示「您当前发送过于频繁，请稍后再试」。
- **方案**：
  1. 封装 `api` 客户端统一处理 429：从 response header 读 `Retry-After`，toast 里显示剩余秒数。
  2. 在批量发送按钮上加一个 cooldown 动画。
- **工作量**：2 小时。

### M3. 侧边栏导航没有可读文本 / 可访问名称

- **现象**：`preview_snapshot` 输出里，侧边导航全部是 `link → image` 结构，没有可被屏幕阅读器朗读的文本。
- **根因**：`client/src/App.jsx` 里的 nav items 只挂了 icon，没有 `aria-label` 也没有 title。
- **方案**：
  1. 每个 `<NavLink>` 加 `aria-label={t('nav.xxx')}`（key 已在 i18n 字典里）。
  2. 悬停展示文本（已有 tooltip 样式的话复用；没有的话加 `title` 属性）。
  3. 移动端可以在点击时展开文字。
- **工作量**：2 小时。

### M4. Icon 按钮缺少无障碍名称

- **现象**：`<button className="btn-icon" onClick={() => handleDelete(p.id)}>🗑</button>`（emoji-only）。
- **方案**：批量改成 `<button aria-label={t('common.delete')}>...` 或 `title={t('common.delete')}`，两者都加最安全。
- **工作量**：1 小时（grep 一遍所有 `className="btn-icon"`）。

### M5. Pipeline 默认关键词硬编码且是英文

- **现象**：[client/src/pages/PipelinePage.jsx:50](client/src/pages/PipelinePage.jsx:50) 附近默认 discovery keywords `'gaming AI roleplay, ...'` 写死在代码里。
- **方案**：
  1. 存到 workspace settings（后端 `workspace_settings` 表加 `default_discovery_keywords` 字段，或者直接放 `workspaces.metadata.jsonb`）。
  2. Settings 页加编辑入口。
  3. 默认值从当前硬编码迁过去。
- **工作量**：半天。

### M6. 表单控件缺少 `<label>`，靠 placeholder 识别字段

- **现象**：CampaignList、ContentStudio 等多处 `<input placeholder={...} />` / `<select>` 没有关联 `<label for>`。WCAG 2.1 Level A 不合规。
- **方案**：
  1. 抽一个 `components/FormField.jsx`（label + input + error slot）。
  2. 改造工作量较大的可以先加 `aria-label`，作为过渡。
- **工作量**：2–3 天（全量改造）；加 aria-label 半天即可。

### M7. 长耗时 Conductor Plan 没有进度展示

- **现象**：[client/src/pages/ConductorPage.jsx](client/src/pages/ConductorPage.jsx) 生成 plan 可能耗时 10s+，只有一个「thinking...」文案，用户体感很差。
- **方案**：
  1. 后端 plan 路由改成 SSE，把中间 step 推给前端（"分析目标…"→"拉取数据源…"→"生成任务…"）。
  2. 或者至少展示「已思考 X 秒」计时器 + 取消按钮。
  3. 失败时提供「编辑 goal 后重试」，保留上次输入。
- **工作量**：1 天。

---

## 四、🟡 低优先级（体验细节、清理）

### L1. React Router v6 future flag 警告

- **现象**：Console 有 `React Router Future Flag Warning` 反复出现。
- **方案**：在 `<HashRouter>` 上开启：
  ```jsx
  <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
  ```
- **工作量**：5 分钟。

### L2. Orphan Gmail 代码（来自本次 rebase）

- **现象**：本次 rebase 选择保留 mailbox_accounts 架构，origin PR #1 引入的 [server/gmail.js](server/gmail.js) 整文件 + [server/email.js:11](server/email.js:11) 的 `const gmailSender = require('./gmail')` 死代码留着没清理。
- **方案**：
  1. 删 `server/gmail.js`。
  2. 删 `server/email.js` 顶部死 require。
  3. 检查 `server/migrations.js` 里 `platform_connections` 的 Gmail OAuth 列是否还被其他代码用（如果只为 Gmail 用，也可清理，但优先保留表结构避免历史数据丢失）。
- **工作量**：30 分钟。

### L3. 服务端 console.warn 泄漏到生产日志

- **现象**：[server/email-jobs.js:43](server/email-jobs.js:43) 直接 `console.warn(...)`。
- **方案**：引入 `pino` 或简单 wrapper（`log.debug` / `log.warn` / `log.error`），生产环境默认 warn 以上。可以渐进替换。
- **工作量**：1 天（建立 logger + 替换高频文件）。

### L4. 部分 API 错误信息只有英文

- **现象**：后端诸如 `'No recipient email'`、`'Email not configured. Set RESEND_API_KEY...'` 是英文字符串，直接回给前端当 toast 显示。
- **方案**：
  1. 后端返回错误 code（`NO_RECIPIENT`、`EMAIL_NOT_CONFIGURED` …）。
  2. 前端 `api` 客户端拦截 error，按 code 查 i18n 字典。
- **工作量**：1 天。

### L5. 请求去重 / 缓存层缺失

- **现象**：切换页面时相同的 `campaigns/:id/roi`、`campaigns` list 会重复请求；没有 SWR/React-Query。
- **方案**：
  1. 引入 `@tanstack/react-query`（包体增加 ~12KB gzipped，但能顺手解决 loading/error state）。
  2. 老页面可以按需迁移，新页面直接用。
- **工作量**：引入基础设施 1 天；逐页迁移另算。

---

## 五、⚙️ 可加分但非紧急

### X1. Bundle 尺寸

当前 build 产物（见 `./deploy.sh` 输出）：

| Asset | Size | Gzipped |
|---|---|---|
| `recharts-*.js` | 434 KB | 115 KB |
| `index-*.js` | 346 KB | 92 KB |
| `react-*.js` | 164 KB | 54 KB |

recharts 是最大单项。替代方案：
- 按页面 lazy import（`RoiDashboard`、`AnalyticsPage` 已经 lazy 了，确认 recharts 只在这些 chunk 里）。
- 长期考虑 [echarts](https://echarts.apache.org/) 的 treeshake 版本，或者 [visx](https://airbnb.io/visx/)（按需引入）。

### X2. 测试覆盖

- **已有**：`server/__tests__/` 下 ab-significance、email-jobs、roi-dashboard、scheduler、secrets、workspace-scope 都有单测。
- **缺口**：
  - 前端没有单元测试 / 组件测试（未见 `client/src/**/__tests__/`）。
  - 没有 E2E（Playwright / Cypress）覆盖「登录 → 建 campaign → 发邮件」主流程。
- **建议**：加 Playwright，至少 3 条冒烟 case（登录、发一封 demo 邮件、查看 ROI）。

### X3. 可观测性

- 没看到 Sentry / Datadog 客户端；线上异常没有上报通道（除了 H1 里建议的 client-errors 落表）。
- 建议至少在后端接 structured logging，Cloud Run 日志按 severity 过滤。

---

## 六、行动计划（建议 2 个迭代完成）

### Sprint 1（优先保证稳定性 & 可用性）— 约 4 人日

| Item | Owner | 估时 | 状态 |
|---|---|---|---|
| H1 ErrorBoundary | frontend | 0.5d | ☐ |
| H2 Cloud Run env→secret 迁移（Runbook + 执行） | devops | 0.5d | ☐ |
| H3 500 端点降级（fail-fast + 前端提示） | full-stack | 1d | ☐ |
| H4 RoiDashboard / ContactModule / PipelinePage 错误态改造 | frontend | 1.5d | ☐ |
| M2 429 友好提示 | frontend | 0.25d | ☐ |
| L1 React Router future flag | frontend | 5 min | ☐ |
| L2 删 orphan gmail 死代码 | backend | 0.5h | ☐ |

### Sprint 2（体验 & 规模）— 约 5 人日

| Item | Owner | 估时 | 状态 |
|---|---|---|---|
| M1 轮询架构 → 自适应 + SSE（可选） | full-stack | 2–3d | ☐ |
| M3 + M4 侧边栏 aria-label + icon 按钮 aria-label | frontend | 0.5d | ☐ |
| M5 默认关键词搬到 workspace settings | full-stack | 0.5d | ☐ |
| M6 `<FormField>` 组件 + 主要表单改造 | frontend | 2d | ☐ |
| M7 Conductor plan SSE 进度 | full-stack | 1d | ☐ |

### 后续专题（按需启动）

- **L3 日志体系**：引入 pino，定日志等级。
- **L4 API 错误码标准化 + i18n**。
- **L5 React Query 接入**。
- **X1 bundle 优化**：lazy + recharts 替代评估。
- **X2 前端单测 & Playwright 冒烟**。
- **X3 Sentry 接入**。

---

## 七、附录：审计方法

- **代码结构梳理**：通过子代理扫描 `client/src/pages/`、`server/`，列出页面、主流程、外部依赖、TODO/FIXME。
- **用户视角测试**：`preview_start` 启动本地 client（:5173）与 server（:8080），用 `preview_snapshot` 抓 ROI Dashboard、Pipeline 等页的 a11y 树，用 `preview_console_logs` / `preview_network` 抓运行时错误。
- **部署验证**：`./deploy.sh` 在 GCP 上跑 `gcloud builds submit` + `gcloud run deploy`，构建成功、部署报 env→secret 类型冲突。

**审计快照时间**：2026-04-24（commit `879b2c3`）。
