# KOL 抓取 → 建联 端到端测试报告（2026-04-25）

本地 SQLite 环境跑通了 **发现 → 管道 → 联系人 → 邮件发送** 全链路，结论是**主流程可用，但存在多处工作区隔离漏洞、错误处理缺陷、以及两条并行互不打通的架构分叉**。

---

## ✅ 测试通过的部分

| 流程 | 结果 | 说明 |
|---|---|---|
| YouTube 关键词发现 | ✅ | `POST /api/discovery/start` → `searchYouTubeChannels` → YouTube Data API v3。关键词 "AI gaming"，min_subscribers=10000，返回 "A.I.Games" 频道（1.34M 粉丝）。relevance_score=70。 |
| Pipeline scrape → write → review | ✅ | `POST /api/discovery/jobs/:id/process` 触发，每个频道创建一个 pipeline_job，异步跑 scrape/write/review 三段，~20s 达到 `stage=review`。Email subject/body 生成正常（模板化）。 |
| Contact 批量生成 | ✅ | `POST /api/campaigns/:id/contacts/batch-generate` 根据 workspace 内 KOL 生成联系人 + 邮件草稿。 |
| 邮件队列发送 | ✅ | `POST /api/contacts/:id/send` → `jobQueue.push('email.send')` → worker 调 Resend → 失败信息正确持久化到 `contacts.send_error` → `status: pending → failed` 状态机正常。 |

---

## 🔴 高优先级 Bug（真实 tenant 隔离风险）

### Bug #1 `/api/discovery/start` 不做 workspace 绑定

- **现象**：发起发现任务时 `discovery_jobs.workspace_id = NULL`，且端点没挂 `workspaceContext` 中间件。
- **根因**：[server/index.js:4742-4785](server/index.js#L4742) —— `INSERT INTO discovery_jobs (...)` 缺 `workspace_id` 字段。
- **影响**：任何已登录用户都能发起发现任务；任务不归属任何 workspace。

### Bug #2 `GET /api/discovery/jobs` 泄漏全部 tenant 数据

- **现象**：[server/index.js:4788-4797](server/index.js#L4788) —— `SELECT * FROM discovery_jobs ORDER BY created_at DESC`，**无 WHERE 过滤**。
- **影响**：A 用户能列出 B workspace 的发现任务（含关键词、配置）。**数据泄漏**。

### Bug #3 `GET /api/discovery/jobs/:id` 无权限检查

- **现象**：按 ID 能拿任何 job 的结果（包括 discovered channel 列表）。
- **影响**：同上，更细粒度的数据泄漏。

### Bug #4 `POST /api/discovery/jobs/:id/process` 无权限检查

- **现象**：[server/index.js:4814-4855](server/index.js#L4814) —— 查 job 时不验证 workspace 所有权。
- **影响**：**A 用户能触发 B workspace 的发现任务进入流水线 + 产生垃圾数据**。

### Bug #5 Pipeline jobs 被创建时不带 workspace_id

- **现象**：`discovery → process` 创建 pipeline_jobs 时 `workspace_id=NULL`，`campaign_id='hakko-q1-all'`（硬编码全局种子 campaign）。
- **根因**：[server/index.js:4831](server/index.js#L4831) INSERT 语句没填 workspace_id；campaign_id 回退值写死。
- **连锁故障**：`POST /api/pipeline/jobs/:id/approve`（[4457](server/index.js#L4457)）用 `WHERE id=? AND workspace_id=?` 过滤，返回 404。**发现来的 pipeline job 永远无法被批准发送 —— 整条"发现自动建联"的 pitch 路径是死的**。

**一句话修复思路**：所有四个 `/api/discovery/*` 路由补 `workspaceContext` 中间件 + 所有 SQL 加 `workspace_id` 过滤 + INSERT 时填 `req.workspace.id`。工程量 2 小时。

---

## 🟠 中等优先级（功能可用但错得迷惑）

### Bug #6 Discovery 错误被静默吞掉

- **现象**：[server/index.js:4761](server/index.js#L4761) —— `result.success=false` 时仅 `UPDATE ... status='error'`，不 log、不持久化原因。
- **影响**：测试初次跑时任务显示 `error`，但数据库里完全没线索（只有 `status=error, completed_at=<时间戳>`）。原因是 `YOUTUBE_API_KEY not configured`，需要去翻源码才知道。
- **修复**：
  1. `discovery_jobs` 加 `error_message TEXT` 列。
  2. 失败时 `UPDATE ... error_message=?`，并 `logger.warn('[discovery]', ...)`.
  3. 前端 DiscoveryPage 展示 error_message。

### Bug #7 Pipeline approve 用了被废弃的 sendEmail 签名

- **现象**：[server/index.js:4481-4486](server/index.js#L4481) —— 调 `mailAgent.sendEmail({ workspaceId: req.workspace.id })`。
- **根因**：本次 rebase 决议里 `sendEmail` 签名改为接受 `mailboxAccount` row（[server/email.js 当前签名](server/email.js)），旧的 `workspaceId` 参数被**静默丢弃**。
- **影响**：发现管道里批准的邮件**永远从 env 默认 Resend 发出**，即便 workspace 配了自己的 mailbox_accounts。对现在 "每个 workspace 用共享 Resend" 的现状无影响，但语义已经不对。
- **修复**：把 approve 改走 jobQueue（同 `/contacts/:id/send`），让 `email.send` worker 统一处理 mailbox 解析。顺便消除 approve 的同步长耗时问题。

### Bug #8 Pipeline approve 还在同步 sendEmail

- **现象**：[server/index.js:4481](server/index.js#L4481) —— 在 HTTP handler 里直接 `await sendEmail(...)`，不进队列。
- **影响**：Resend 慢/挂时 HTTP 超时；重试需要手动再点；失败状态回滚到 `review` 比较 ad-hoc。
- **修复**：和 Bug #7 一起，统一走 `jobQueue.push('email.send', ...)`，pipeline_job 状态机改为 `review → queued → sent/failed`。

### Bug #9 batchGenerateEmails 用模板拼字符串，不调 LLM

- **现象**：[server/index.js:~830](server/index.js) —— 生成邮件时是 `Hi ${name}\n\nI hope this message finds you well! I've been following your content on ${platform}...` 的硬编码模板替换，不调 Anthropic/OpenAI。
- **影响**：页面叫 "AI 邮件生成"，但实际上没有 AI。用户以为是 LLM 生成的个性化文案，实际上对 100 个 KOL 发的都是一模一样的 boilerplate。**预期与实际不符，容易被垃圾邮件过滤**。
- **两种决策**：
  - (a) 保留模板，改文案让用户知道这是模板（"使用模板生成"而不是 "AI 生成"）
  - (b) 真的接 Anthropic，生成个性化邮件（每封 ~$0.01，成本可接受）
- 建议 (b)，我们的 [templates + A/B 基础设施](server/ab-significance.js) 本来就是冲这个来的。

### Bug #10 Scrape 不尝试邮箱发现

- **现象**：Pipeline scrape 阶段只从 YouTube channel description 拿 email。拿不到的 KOL 最终 `email_to=""`，approve 时 400 报 `No email address available`。
- **已有基础设施**：`HUNTER_API_KEY` 已配置、[server/email-finder.js](server/email-finder.js)（如果存在）或 Hunter API 可用，但 scrape 没调。
- **修复**：scrape 失败找到 email 时，降级调 Hunter `domain-search` 或 `email-finder` API。

---

## 🟡 设计层 / 架构分叉

### Issue #11 两条并行互不打通的流程

系统里有**两套不相交的邮件发送路径**，都叫 "outreach"：

| Flow | 入口 | 数据模型 | 发送路径 | UI 页面 |
|---|---|---|---|---|
| **A. Pipeline** | Discovery 处理 / 手动粘 URL | `pipeline_jobs` | approve 同步调 sendEmail | PipelinePage |
| **B. Contacts** | KOL 加入 campaign → batch-generate | `contacts` | `/contacts/:id/send` → jobQueue | ContactModule |

**问题**：
- Pipeline 里 scrape 到的 KOL 不会自动变成 `contacts`。用户要么只用 A，要么只用 B，或者手动复制 email 从 A 贴到 B。
- `email_replies`、`email_events`、回复追踪这些基础设施是 B 独享，A 发出去的邮件**追踪不到**。
- 前端两套 UI（PipelinePage 的 "Email Tasks" tab 和 ContactModule 的 "Contacts" tab）展示的是不同数据，用户糊涂。

**建议**：
- 短期：discovery-process 时在 pipeline_job 的 write 阶段结束后，同时 INSERT INTO contacts（两边引用同一 pipeline_job_id）。
- 长期：废掉 pipeline_jobs 独立的 send 路径，全部走 contacts + jobQueue。Pipeline 仅作为"生成阶段"的可视化。

### Issue #12 `hakko-q1-all` 硬编码 campaign 到处泄漏

- `/api/discovery/start`、`/api/discovery/jobs/:id/process`、服务器 `seedDemoData()` —— 都把 `'hakko-q1-all'` 作为 fallback campaign ID。
- **影响**：新 workspace 即便创建了自己的 campaign，discovery 不传 `campaign_id` 时就会落到那个全局 demo campaign 里。
- **修复**：fallback 应该选"当前 workspace 第一个 active campaign"。

---

## 📋 建议修复顺序

### Sprint 1（安全 & 阻塞，优先）— 约 1 天

1. **所有 `/api/discovery/*` 加 workspace 隔离**（Bug #1-5）—— 上 `workspaceContext` 中间件 + SQL WHERE + INSERT workspace_id。同时修 `hakko-q1-all` 硬编码（Issue #12）。
2. **Pipeline approve 改走队列**（Bug #7+#8）—— 让它和 `/contacts/:id/send` 走同一个 `email.send` job handler。
3. **Discovery 错误可见**（Bug #6）—— 加 `error_message` 列 + UI 展示。

### Sprint 2（流程合并 & 个性化）— 约 2-3 天

4. **Discovery-to-contact 自动衔接**（Issue #11）—— write 阶段结束后同步 INSERT INTO contacts。
5. **真用 LLM 生成邮件**（Bug #9）—— 接入 Anthropic，保留模板作为 fallback。
6. **Scrape 降级 Hunter 找邮箱**（Bug #10）。

---

## 附：本次测试使用的命令

本地 SQLite 沙盒（不污染 prod）：
```
mv .env .env.prod-backup
# 写一份只含 YOUTUBE_API_KEY / ANTHROPIC_API_KEY / RESEND_API_KEY / HUNTER_API_KEY 的 .env
preview_start influencex   # 起 server（SQLite fallback）
preview_start influencex-client
```

登录 + 发现：
```
POST /api/auth/login { email, password }
POST /api/discovery/start { keywords, min_subscribers, max_results }
GET  /api/discovery/jobs/:id           # 轮询直到 complete
POST /api/discovery/jobs/:id/process   # 生成 pipeline_jobs
```

联系人 + 发送：
```
POST /api/campaigns/:cid/contacts/batch-generate { cooperation_type }
POST /api/contacts/:cid/send           # 进队列
# 查 contacts.status / send_error 观测结果
```

还原：
```
rm .env && mv .env.prod-backup .env
```

**测试时间**：2026-04-25
**测试版本**：HEAD `2728811`
**耗时**：~15 min 从冷启动到测出所有问题
