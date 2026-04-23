# KOL 外联邮件能力升级方案

> 基于现有平台结构的落地方案。不新建独立邮件中心，而是在 Contacts / Connections / Pipeline 三处补齐能力。Conductor 作为二期自动化编排入口。

---

## 一、结论：需求与现状高度契合，应"补齐"而非"新建"

项目已经有相当完整的外联骨架。不需要新建邮件中心模块，只需在三处补能力：

| 模块 | 现状 | 需要补 |
|---|---|---|
| `client/src/pages/ContactModule.jsx` | 已有 Write/Review/Send/Monitor 全流程、线程视图、批量生成 | 批量**发送**、状态字段扩展、单 KOL 抽屉、模板 CRUD |
| `client/src/pages/ConnectionsPage.jsx` | 只有社媒 OAuth (`server/publish/oauth.js`) | 新增邮箱连接卡片（Resend / SMTP / Gmail OAuth） |
| `client/src/pages/PipelinePage.jsx` | 只有 scrape/write/review/send/monitor 阶段 | 新增"邮件任务"筛选：批量发送 / 追踪 / 重试 |
| `client/src/pages/ConductorPage.jsx` | 已是编排入口 | **一期不动**，二期加"一句话外联"goal 模板 |

---

## 二、两种发送路径（并行、共用一张 `contacts` 表）

平台同时支持"批量发送"和"单个定制发送"，两条路径共享同一份数据：

| 路径 | 入口 | 用途 | 数据流 |
|---|---|---|---|
| **批量** | Contacts 顶部 `Bulk Send Email` | 勾选多个 KOL，统一选模板，按各自 `contacts.email_body` 发 | `batch-send` → `email.batch_send` job → N × `email.send` |
| **单个定制** | Contacts 行内 `Send Email` → 右侧抽屉 | 针对一个 KOL 单独编辑主题 / 正文 / 签名 / 附件；可基于模板填充后再改 | 抽屉保存走 `PUT /api/contacts/:id`，发送走 `POST /api/contacts/:id/send` |

核心前提：`contacts` 表本身就是"一 KOL 一行"，`email_subject` / `email_body` 是 per-row 的，所以"定制内容"天然独立持久化，不会被批量发送覆盖。批量路径只读取每行当前的 subject/body，不做二次改写。

在抽屉里的操作链路：
1. 选模板 → 前端 `renderTemplate()` 预览（变量用当前 contact + campaign 自动填充）
2. 用户手动修改主题 / 正文 / 签名
3. 保存为该 KOL 的 draft（`PUT /api/contacts/:id`）
4. 点"立即发送"或"定时发送"（`POST /api/contacts/:id/send`）
5. 抽屉 Tab 1 立刻切到线程视图，看状态流转

---

## 三、Gap 清单（对照需求逐项核对）

| 需求项 | 现状 | 一期动作 |
|---|---|---|
| 批量发送 | 仅批量**生成** (`server/index.js:1105`) | 新增 `POST /campaigns/:id/contacts/batch-send` |
| 单个发送 | 已有 `server/index.js:836` | 仅前端改造为侧抽屉 |
| 模板 + 变量 | 仅内置 4 个模板 (`server/email-templates.js:22`) | 新表 `email_templates` + Contacts 内模板管理 |
| 状态：draft / sent / replied | 已有 | 保留 |
| 状态：delivered / opened / bounced / failed | 缺失，无 tracking | 接入 Resend webhook events + 新字段 |
| 沟通线程 | 已有 `email_replies` + `server/index.js:1009` | 仅前端抽屉化 |
| 邮箱授权 | 仅 env 里的 `RESEND_API_KEY` / `SMTP_*` | 新表 `mailbox_accounts` + Connections UI |
| 失败重试 | 发送是同步的，无重试 | 改走 `job-queue` + Pipeline 可视化 |
| 签名 / 发件人名称 | 仅 env `EMAIL_FROM_NAME` | 随 `mailbox_accounts` 持久化 |

---

## 四、数据模型改动（`server/migrations.js`）

```sql
-- 1. 扩展 contacts 追踪字段
ALTER TABLE contacts ADD COLUMN delivered_at DATETIME;
ALTER TABLE contacts ADD COLUMN first_opened_at DATETIME;
ALTER TABLE contacts ADD COLUMN last_opened_at DATETIME;
ALTER TABLE contacts ADD COLUMN bounce_reason TEXT;
ALTER TABLE contacts ADD COLUMN send_error TEXT;
ALTER TABLE contacts ADD COLUMN send_attempts INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN mailbox_account_id INTEGER;
-- contacts.status 增加值：pending / delivered / opened / bounced / failed

-- 2. 用户可编辑模板（内置模板继续作为 seed）
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  language TEXT,             -- en / zh
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  variables JSON,            -- 可替换变量白名单
  created_by INTEGER,
  created_at DATETIME,
  updated_at DATETIME
);

-- 3. 发件邮箱
CREATE TABLE mailbox_accounts (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  provider TEXT NOT NULL,        -- 'resend' | 'smtp' | 'gmail_oauth'
  from_email TEXT NOT NULL,
  from_name TEXT,
  signature_html TEXT,
  credentials_encrypted TEXT,    -- OAuth token / SMTP pwd
  status TEXT,                   -- active / revoked / error
  is_default INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at DATETIME
);

-- 4. 邮件事件（Resend webhook）
CREATE TABLE email_events (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER,
  resend_email_id TEXT,
  event_type TEXT,               -- delivered / opened / clicked / bounced / complained / failed
  payload JSON,
  occurred_at DATETIME
);
```

`email_replies` 和 `pipeline_jobs` 保留不动。

---

## 五、API 新增 / 调整（`server/index.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/campaigns/:id/contacts/batch-send` | 入队批量发送任务，返回 `job_id` |
| POST | `/api/contacts/:id/send` | **改为**入队 + 落 `contacts.status=pending` |
| POST | `/api/contacts/:id/retry` | 强制重试失败项 |
| GET | `/api/contacts/:id/thread` | 已存在，**追加 email_events 时间线** |
| CRUD | `/api/email-templates` | 模板管理 |
| POST / GET | `/api/mailboxes` | 邮箱账号管理 |
| GET | `/api/mailboxes/oauth/:provider/start` | Gmail OAuth（二期可） |
| POST | `/api/webhooks/resend/events` | 接收 delivered / opened / bounced 事件，落 `email_events` + 同步 contacts 字段 |

---

## 六、`job-queue` 集成（`server/job-queue.js`）

注册新的任务处理器：

- `email.send` — 单封发送，失败按指数退避重试 3 次
- `email.batch_send` — 展开为 N 个 `email.send` 子任务
- `email.sync_status` — 轮询近 24h 未 delivered 的邮件（兜底，主要靠 webhook）

Pipeline 页面过滤条件新增 `category in ('email.send','email.batch_send','email.sync_status')`，复用现有的 `StageProgress`。

---

## 七、前端改造

### ContactModule（主入口）

- 顶部操作区加 `Bulk Send Email` 按钮（已选中 N 个 KOL 时可用）
- 每行追加 `Send Email` 按钮 → 打开**右侧抽屉**（新建 `ContactThreadDrawer.jsx`）
  - Tab 1：线程（沿用现有 `getContactThread` + 新的 events 时间线）
  - Tab 2：撰写（模板下拉 + 变量预览 + 签名选择 + 立即/定时发送）
- 列表新增列：`Email Status`（9 态 badge）/ `Last Opened` / `Last Reply`
- 模板管理：列表页右上角 `Manage Templates` 入口，抽屉表单

### ConnectionsPage

- 新增分组 "Mailbox"，卡片：Resend / SMTP / Gmail (OAuth)
- 复用现有 `initOAuth()` popup 机制

### PipelinePage

- 已有的 tab / stat 基础上加分类 chip：`Email Send` / `Email Tracking` / `Email Retry`
- 重试按钮调 `POST /contacts/:id/retry`

---

## 八、i18n

新字符串归属（按最近 batch 1-5 的风格补齐 zh / en 两套）：

- `contacts.*` — 批量发送、模板、状态文案（已有命名空间 `client/src/i18n.jsx:624`）
- `connections.*` — 邮箱授权（`client/src/i18n.jsx:392`）
- `pipeline.*` — 邮件任务分类（`client/src/i18n.jsx:792`）

---

## 九、一期 / 二期拆分

### 一期（推荐合入顺序）

1. 迁移脚本 + 新表（contacts 扩展字段、email_templates、mailbox_accounts、email_events）
2. `job-queue` 接管 `email.send`，批量发送 API
3. Resend events webhook + 时间线
4. Contacts 抽屉 UI + 状态列
5. 模板 CRUD
6. Connections 邮箱卡片（Resend / SMTP 足够）
7. Pipeline 分类展示 + 重试

### 二期

- Gmail / Outlook OAuth 邮箱（`mailbox_accounts.provider=gmail_oauth`）
- Conductor goal 模板："send first-round outreach to approved KOLs in current campaign"
- 定时发送 / A/B / ROI 报表

---

## 十、风险点

1. **Resend 单账号 vs 多租户邮箱** — 当前 `server/email.js:19` 只读 env 全局配置；引入 `mailbox_accounts` 后发送路径必须按 `contacts.mailbox_account_id` 路由，注意向后兼容（缺省回落到 env）。
2. **同步 → 异步迁移** — `server/index.js:836` 现在是同步返回成功，前端直接刷新。改为入队后需要前端轮询 / SSE 状态，否则"点发送后没反馈"。
3. **Open tracking 依赖 Resend pixel** — 如果用户用 SMTP 分支就没法追踪 opens，UI 需要提示"当前邮箱不支持已读追踪"。
4. **Webhook 签名验证** — 现有 `server/index.js:940` 的 Resend inbound webhook 要核对是否有签名校验；新加的 events webhook 必须校验。

---

## 十一、起手式

建议从 **第一步数据库迁移 + `job-queue` 接管发送** 起手，这是所有 UI 改造的前置。

---

## 十二、二期进度（2A 已交付）

### 已交付（Phase 2A）

| 能力 | 落点 |
|---|---|
| 定时发送 UI + 取消 | `ContactThreadDrawer` 里新增 `datetime-local` + Schedule / Cancel 按钮 |
| 定时走同一队列 | `server/scheduler.js` 改为入队 `email.send`，享用同套重试/事件/状态 |
| Scheduled tab | `ContactModule` 新增 tab + 行内 🕒 徽章显示预计发送时间 |
| Conductor 预置目标 | `ConductorPage` 顶部三个快速开始按钮，首轮外联自动带入当前 campaign 名字 |

### 二期 B 已交付

| 能力 | 落点 |
|---|---|
| **ROI 邮件漏斗** | `server/roi-dashboard.js` 漏斗扩展为 sent → delivered → opened → replied → signed → content → paid；`delivery_rate` / `open_rate` / `bounce_rate` 新字段；`RoiDashboard` 页面漏斗条形图 + 6 张比率卡片 |
| **A/B 模板变体** | 迁移 `2026-04-23-ab-template-variants` 加 `email_templates.variant_of/variant_label`、`contacts.template_id/variant_id`；`/api/email-templates/:id/variants` CRUD + `/pick-variant` 做均匀抽选 + `/stats` 输出每变体的 sent/opened/reply 对比；`TemplateManagerDrawer` 支持展开变体面板 + 内嵌统计表；`ContactThreadDrawer` 应用模板时若有变体则走 `pick-variant` 记录归因 |
| **Gmail OAuth 邮箱** | 新增 `server/mailbox-oauth-gmail.js`（authorization code + refresh flow）；路由 `/api/mailboxes/oauth/gmail/init` + `/callback` + `/status`；`server/email.js` 为 `provider='gmail_oauth'` 走 Gmail API (`users.messages.send` with RFC822 base64url)；`email-jobs.js` 刷新 token 后自动持久化；`ConnectionsPage` 加 Connect Gmail 按钮 |

### Gmail OAuth 最后一英里（运维动作）

平台代码已经就绪，要真正让用户连 Gmail，需要管理员做一次性配置：

1. **Google Cloud Console** — 新建项目（或复用现有项目）
2. **启用 Gmail API**：Console → APIs & Services → Library → 搜 "Gmail API" → Enable
3. **OAuth 同意屏幕**（Consent Screen）
   - User Type: External（需要全部 Google 用户都能连接）
   - App name / support email / developer email 填写
   - Scopes：添加 `.../auth/gmail.send`、`openid`、`email`、`profile`
   - Test users：开发期把要测试的 Google 账号加进来；发布到 Production 需 Google 审核（2–5 天，只要用 `gmail.send` 一个 restricted scope 就要 security assessment）
4. **OAuth Client ID**
   - Type: Web application
   - Authorized redirect URI: `{OAUTH_CALLBACK_BASE}/api/mailboxes/oauth/gmail/callback`
     - 本地：`http://localhost:8080/api/mailboxes/oauth/gmail/callback`
     - 生产：改 `OAUTH_CALLBACK_BASE` env 即可
5. **设置 env 并重启**：
   ```
   GMAIL_OAUTH_CLIENT_ID=...
   GMAIL_OAUTH_CLIENT_SECRET=...
   OAUTH_CALLBACK_BASE=https://your-domain  (可选，默认 http://localhost:8080)
   ```
6. **用户侧流程**：Connections 页 → Mailboxes 栏的 `✉️ Connect Gmail` 按钮（配置前会是灰色 `Gmail (setup required)`）→ 弹窗 Google 授权 → 回来后自动创建一行 `mailbox_accounts.provider='gmail_oauth'`

### 二期 C 已交付（本次最后一批推进）

| 能力 | 落点 |
|---|---|
| **批量发送带模板** | `/batch-send` 加 `template_id` 参数：服务端按每 KOL 渲染变量 + 均匀挑选变体，一次应用到整批。UI 是 Contacts 顶部批量按钮打开的 BulkSendModal |
| **跟进走队列** | 原 `scheduler.js` 跟进分支直接 `mailAgent.sendEmail`，现统一入队 `email.send` with `kind='followup'`。享受重试/事件/状态。`email-jobs.js` 里 `email.send` 处理器支持 `subjectOverride`/`bodyOverride`/`kind` |
| **多步跟进序列** | `FOLLOW_UP_INTERVALS_DAYS="4,10"` env 控制任意步数间隔（legacy `MAX_FOLLOW_UPS` + `FOLLOW_UP_AFTER_DAYS` 仍兼容）。scheduler 按 `follow_up_count` 匹配对应 step |
| **线程显示变体归因** | `/contacts/:id/thread` 返回 `contact.variant_info`；抽屉 Thread 顶部徽章 `🧪 Sent using template "X" · variant "Y"` |
| **Pipeline Email Tasks 显示 Scheduled** | 新增"Scheduled sends"表格 + Scheduled stat 卡 |
| **per-contact 邮箱选择器** | 抽屉 Compose Tab 加 `Send from` 下拉；SMTP 邮箱会显示"不支持打开追踪"的黄色提示 |
| **A/B 自动赢家** | 新迁移 `email_templates.winner_variant_id`；`/stats` 自动做 two-proportion z-test（min sample 30, p < 0.05），返回 `suggested_winner`；`/promote-winner` 锁定赢家后 `pick-variant` 100% 走该变体 |
| **Email events 时间线图表** | `getCampaignRoi` 返回 `email_timeline`（近 30 天按天聚合）；ROI 页用 Recharts LineChart 绘制 sent/delivered/opened/replied/failed |
| **手动触发 sync_status** | `POST /email-queue/sync-status`；Pipeline › Email Tasks 顶部加"🧹 Sweep stuck sends"按钮 |
| **凭证静态加密** | 新增 `server/secrets.js` (AES-256-GCM)；env `MAILBOX_ENCRYPTION_KEY` 32 字节 base64；新写入落 `aead:v1:...` 密文，旧明文行兼容读取；dev 无 env 时用宿主 hostname 派生密钥（附警告） |
| **Gmail 验证分支** | `mailAgent.verifyConnection()` 对 `gmail_oauth` 走 refresh + profile ping，返回 `refreshedCreds` 让调用方持久化 |
| **Gmail DNS 检查器** | `GET /api/mailboxes/:id/dns-check` 查 SPF/DKIM/DMARC 并给出配置建议；Connections 每个邮箱卡片加 DNS check 按钮 + Modal |
| **预先修复的 bug** | `/contacts/:id/workflow` PATCH 的参数重复 push；Resend inbound webhook 的 `email_replies` insert 补上 `workspace_id` |

### 环境变量索引（全部）

```
# 一期
RESEND_API_KEY=re_xxx                    # 或 SMTP_HOST/SMTP_USER/SMTP_PASS
RESEND_FROM_EMAIL=contact@yourdomain
RESEND_REPLY_TO=reply@yourdomain
RESEND_WEBHOOK_SECRET=whsec_...

# 二期 A
SCHEDULER_TICK_MS=300000
FOLLOW_UP_AFTER_DAYS=4       # legacy (deprecated — use intervals)
MAX_FOLLOW_UPS=1             # legacy (deprecated — use intervals)
FOLLOW_UP_INTERVALS_DAYS=4,10,18   # multi-step

# 二期 B/C
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
OAUTH_CALLBACK_BASE=http://localhost:8080
MAILBOX_ENCRYPTION_KEY=<base64 32 bytes>   # openssl rand -base64 32
```

### 二期 D 已交付（运维/质量收尾）

| 能力 | 落点 |
|---|---|
| **自动化测试 36 例** | `server/__tests__/secrets.test.js` (9) / `scheduler.test.js` (5) / `email-jobs.test.js` (8) / `roi-dashboard.test.js` (6) / `ab-significance.test.js` (8)。抽屉 E2E 仍是手测 |
| **Workspace 级 RPM 限流** | `EMAIL_SEND_WORKSPACE_RPM=120` 默认；单发/重试/批量都走。批量大小 > RPM 直接 429 拒绝前置 |
| **Hard-bounce 自动禁发** | 新迁移 `kols.email_blocked_at`；Resend events webhook 里 `bounce` 达 `HARD_BOUNCE_BLOCK_THRESHOLD=2` 或 `complained` 单次即置屏蔽；send handler 遇屏蔽直接 `status='failed'` 短路；UI 在联系人行显示 🚫 badge + Unblock 按钮；`POST /api/kols/:id/unblock-email` 管理员解除 |
| **密钥轮换 CLI** | `server/scripts/rotate-mailbox-key.js`（`npm run rotate-mailbox-key`）：读 → 用旧 key 解密 → 用新 key 重新加密，支持 `--dry-run`，legacy 明文行同步迁移；事务保证一致性 |
| **A/B 显著性抽离** | `server/ab-significance.js` — two-proportion z-test + 内置 normalCdf (A-S 26.2.17)。单测覆盖单调性、对称性、退化输入 |

### 全部环境变量（终版索引）

```
# 一期
RESEND_API_KEY=re_xxx
RESEND_FROM_EMAIL / RESEND_REPLY_TO / RESEND_WEBHOOK_SECRET
SMTP_HOST / SMTP_USER / SMTP_PASS                  # 备选

# 二期 A — 定时 / 跟进
SCHEDULER_TICK_MS=300000
FOLLOW_UP_INTERVALS_DAYS=4,10,18                   # 多步（推荐）
FOLLOW_UP_AFTER_DAYS / MAX_FOLLOW_UPS              # legacy 单步

# 二期 B — Gmail OAuth
GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET
OAUTH_CALLBACK_BASE=http://localhost:8080

# 二期 C — 安全 / 限流
MAILBOX_ENCRYPTION_KEY=<base64 32 bytes>           # openssl rand -base64 32
EMAIL_SEND_WORKSPACE_RPM=120
HARD_BOUNCE_BLOCK_THRESHOLD=2
SENDER_NAME / PRODUCT_NAME                         # 模板变量默认值
```

### 真正还未做（留给下一阶段或外部）
- **Gmail/Resend 实连** — 需要外部凭证，代码完备
- **抽屉 E2E** — Playwright/Cypress 跑 Contacts → drawer → 发送的端到端
- **`/scheduler/tick` RBAC 放宽** — 当前需 `system.manage`，可考虑授予 workspace admin
- **密钥轮换 CLI 增量模式** — 现在每行都重写；大表可以只重写非密文行
- **UI 统一** — 抽屉内联样式→CSS class；其他几篇 docs (README / STATUS_AND_GAPS / USER_GUIDE) 同步

