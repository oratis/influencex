# InfluenceX 测试指南

> **版本**：基于 commit `4619956`（Sprint 2 — A/B winner UX + Hunter Email Finder + pgvector wiring）
> **最后更新**：2026-04-27
> **目标读者**：QA、产品、开发、新加入会话的 Claude Code
> **使命**：在没有自动化前端测试的当下（Sprint 2 任务 C2 才会引入 Vitest），用结构化手测覆盖所有用户可见功能。

---

## 0. 测试前置条件

### 0.1 环境准备

| 环境 | 用途 | 数据库 | 地址 |
|---|---|---|---|
| 本地（SQLite fallback） | 日常功能验证、不污染 prod | better-sqlite3 | `http://localhost:5173/`（Vite）+ `http://localhost:8080/`（Express） |
| 本地（连 prod Postgres） | 复现 prod 数据问题 | Cloud SQL via proxy 5434 | 同上 |
| 生产 | 烟测、上线验收 | Cloud SQL Postgres 15 | https://influencexes.com/ |

**本地启动（推荐 SQLite 沙盒）**：

```bash
# 临时隐藏 prod env，避免误连 Cloud SQL
mv .env .env.prod-backup

# 写一份只含 LLM key 的最小 .env（参考 .env.example）
# ANTHROPIC_API_KEY=sk-ant-...
# RESEND_API_KEY=re_...
# MAILBOX_ENCRYPTION_KEY=<base64 32-byte>

preview_start influencex          # server :8080
preview_start influencex-client   # vite :5173 (HMR)

# 测完还原
rm .env && mv .env.prod-backup .env
```

### 0.2 测试账号准备

- **Admin**：`wangharp@gmail.com`（prod 唯一 admin）
- **本地 admin**：首次启动 server 时 seed 会自动创建一个 admin 账号；查 server 启动日志或 `users` 表
- **邀请测试**：用任意未注册邮箱，admin 账号在 `/users` 页面发邀请 → 拿到 token → 打开 `/#/accept-invite?token=...`

### 0.3 通用核查清单

每完成一项功能测试，确认：
- [ ] UI 显示符合 [`design.md`](./design.md)（暗色、无 light-gray、icon 按钮带 aria-label）
- [ ] EN + ZH 切换都跑一次（`<LanguageSwitcher />` 在 GlobalHeader）
- [ ] Workspace 切换后数据正确隔离（不应看到别的 workspace 的 KOL/contact）
- [ ] 失败路径有错误反馈（不是空白页或永久 spinner）—— `<ErrorCard>` 或 toast
- [ ] 长任务（>500ms）有进度反馈
- [ ] DevTools Network 无 4xx/5xx 散发

---

## 1. 公开页面（未登录）

### 1.1 Landing Page `/`

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 渲染正确 | 浏览器打开 `https://influencexes.com/` | 看到产品介绍、CTA「Sign in」按钮 |
| 域名拼写 | 看 URL | `influencexes.com`（**不是** `influencex.com`） |
| EN/ZH 切换 | 点语言切换 | 文案完整切换；刷新后保持上次选择 |
| Sign in 跳转 | 点 CTA | 跳到 `/#/login` |

### 1.2 Login `/login`、`/auth`

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 邮箱密码登录（成功） | 输入正确凭据 | 跳到 `/#/conductor`（默认首页） |
| 邮箱密码登录（错误） | 错误密码 | 错误 toast，不跳转 |
| Google SSO | 点「Sign in with Google」 | OAuth 弹窗 → 回调成功 → 跳进 app |
| 公开注册被禁用 | 直接 `POST /api/auth/register` | 返回 410 `REGISTRATION_DISABLED` |
| 错误码本地化 | 错误时切到 ZH | 错误信息中文（key 不裸露） |

### 1.3 Accept Invite `/accept-invite?token=...`

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 有效邀请 | 用 admin 发的有效 token | 显示邀请详情 + 设置密码表单；自动聚焦 name input |
| 无效/过期 token | 改 token 字符 | 错误页面，提示重新申请 |
| 邮箱已注册 | 邀请已存在 user 邮箱 | 409 `EMAIL_EXISTS` + 「log in instead」链接 |
| 接受成功 | 提交表单 | 自动登录 + 加入 workspace + 跳到 `/conductor` |

---

## 2. 认证 & Workspace 切换

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 登出 | sidebar 用户菜单 → Logout | 清 cookie + 跳到 `/login` |
| 多 workspace 切换 | GlobalHeader 选择另一个 workspace | sidebar 数据全切；本地 storage 持久 |
| Workspace 隔离 | 切到 workspace A 创建 campaign，切到 B | B 看不到 A 的 campaign |
| 默认 workspace | 新登录无 currentWorkspaceId | 自动选第一个 workspace |
| Header `X-Workspace-Id` | 抓包看 API 请求 | 每个 `/api/*` 都带这个 header |

---

## 3. 侧栏导航（17 项）

逐项点开，确认：路由正确、页面渲染无报错、面包屑/页头标题正确、ZH/EN 一致。

| Nav 项 | 路由 | 是否 admin only |
|---|---|---|
| Conductor | `/conductor` | ❌ |
| Content Studio | `/studio` | ❌ |
| Calendar | `/calendar` | ❌ |
| Connections | `/connections` | ❌ |
| Analytics | `/analytics` | ❌ |
| Community | `/inbox` | ❌ |
| Ads | `/ads` | ❌ |
| Translate | `/translate` | ❌ |
| Agents | `/agents` | ❌ |
| Pipeline | `/pipeline` | ❌ |
| Campaigns | `/campaigns` | ❌ |
| ROI | `/roi` | ❌ |
| Contacts | `/contacts` | ❌ |
| Data | `/data` | ❌ |
| KOL Database | `/kol-database` | ❌ |
| Users | `/users` | ✅ admin/editor |
| Workspace Settings | `/workspace/settings` | ✅ admin |

a11y 检查：每个 nav 项 hover 有 tooltip + 屏幕阅读器读出 label（DevTools → Accessibility tab）。

---

## 4. Conductor（AI 目标规划）

### 4.1 路径 `/conductor`

| 测试项 | 步骤 | 预期 |
|---|---|---|
| Preset goal 列表 | 进入页面 | 看到预设 goal 卡片（如 "Find 50 KOLs"、"Launch outreach"） |
| 选 preset | 点某个 preset → Plan | 触发 SSE stream，逐步显示 plan steps |
| 自定义 goal | 输入 "本月新增 10 个签约 KOL" | LLM 生成具体 plan |
| 取消 plan | plan 进行中点 cancel | 流终止，已完成步骤保留 |
| 历史 plans | 翻历史 | 看到之前的 plan，可查看 steps + 结果 |
| LLM 失败处理 | 临时屏蔽 ANTHROPIC_API_KEY | UI 显示错误 toast 而非空白 |

### 4.2 SSE 流稳定性

- DevTools → Network → 看 `/api/conductor/plan` 是 EventSource，逐步收 chunk
- 主动断网 5 秒再恢复，确认前端报错而不是 hang

---

## 5. Campaign 管理

### 5.1 列表 `/campaigns`

| 测试项 | 预期 |
|---|---|
| 创建 campaign | 表单提交后列表立即出现新行 |
| 必填校验 | 不填 name 提交，错误提示 |
| 删除 campaign | 二次确认 → 列表移除；其下 KOL/contact 也消失 |
| 默认 campaign | 新建 workspace 自动有默认 campaign（**不是** `hakko-q1-all`，应该是 `defaultCampaignForWorkspace()` 生成的） |
| `hakko-q1-all` 不出现 | 新 workspace 列表中不应看到这个 ID |

### 5.2 详情 `/campaigns/:id`

| 测试项 | 预期 |
|---|---|
| 编辑 name/desc | 保存后即时反映 |
| KOL tab | 显示该 campaign 关联的 KOL 列表 |
| Contact tab | 显示生成的 contacts |
| ROI tab | 显示该 campaign 的转化指标 |
| Export KOL CSV | 下载 CSV，列名正确，行数与 UI 一致 |
| Export Contact CSV | 同上 |

---

## 6. KOL Discovery & Database

### 6.1 KOL Database `/kol-database`

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 平台筛选 | 选 YouTube / TikTok / Instagram | 列表过滤 |
| 关键字搜索 | 输入 "fitness" | 命中相关频道 |
| 单个 KOL 导入 | 输入 channel URL → Import | 出现在当前 campaign |
| 批量导入 | 粘贴多 URL | 全部入库 |
| 数据完整性 | 看 KOL 行 | 应有 followers / 平均播放 / 联系方式 |

### 6.2 Discovery Job

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 启动 discovery | `POST /api/discovery/start`（或 UI 触发） | job 状态 pending → running → done |
| 多 worker 隔离 | 用 workspace A 启 job 后切 B | B 看不到 A 的 job |
| 失败重试 | 模拟 API key 失效 | 状态 failed + 错误信息 |

---

## 7. Pipeline（外联流程）

`/pipeline` 是 Sprint 1 重点，6 个 stage：`scrape → write → review → send → monitor → done`。

### 7.1 完整链路

| 步骤 | 操作 | 预期 stage |
|---|---|---|
| 启动 | 选 KOL → 点 Start outreach | `scrape` |
| 抓取完成 | 等几秒 | `write`（已有 LLM 生成的邮件 draft） |
| 编辑 draft | 改 subject/body 保存 | 仍 `write`/`review`，内容已更新 |
| 通过审核 | 点 Approve | `send`（job 入队 `email.send`） |
| 邮件发出 | 等 worker 处理 | `monitor`；contact.status = `sent` |
| Resend webhook 回 | 模拟 delivered | `monitor`；contact.status 更新 delivered/opened |
| 用户回信 | 模拟 inbound | `done`（或保留 monitor + 出现 reply） |

### 7.2 边界情况

- **拒绝**：`POST /api/pipeline/jobs/:id/reject` → 移到 review/draft 列
- **未传 workspaceId**：人工调用 `runPipeline()` 漏第 6 参数 → 数据应该 fail-fast，**不能**写到默认 workspace
- **同一 KOL 二次启动**：应允许（每次新 job_id），但提示已存在
- **LLM 失败**：临时屏蔽 ANTHROPIC_API_KEY → fallback 模板邮件（不应整个 stage 失败）
- **Mailbox 未连接**：approve 时报错或排队等连接

### 7.3 Pipeline ↔ Contact 双向同步

- Approve pipeline job → `contacts.status` = pending → sent
- 在 Contact 页直接 send → `pipeline_jobs.stage` 反向同步到 monitor
- 两个页面看到的应是同一行（通过 `pipeline_jobs.contact_id`）

---

## 8. Contact 模块（`/contacts`）

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 列表 + 筛选 | 切 status / campaign | 列表过滤 |
| 添加 contact | 手填 email | 入库 |
| Hunter.io 自动找邮箱 | KOL 有官网 | Hunter API 命中并填充 email |
| Hunter Email-Finder（Sprint 2 新） | KOL 仅有 domain | 调 Hunter Email-Finder 拿候选邮箱 |
| Hunter 无结果 | 无网站 KOL | 友好提示「需手填」 |
| 单发邮件 | 点 Send | 入 `email.send` 队列；UI 状态变 sent |
| 批量发送 | 选多行 → Batch send | 入 `email.batch_send` 队列；逐条状态更新 |
| 回复线程 | 打开 ContactThreadDrawer | 显示历史邮件（含 inbound） |
| Reply | 在 thread drawer 写回信 | 入队、出现在 thread |
| 5s 轮询 | 多 tab 同时打开 | 不应触发 429（自适应退避） |

---

## 9. Email 模板 & A/B 测试（Sprint 2 新）

### 9.1 模板管理（TemplateManagerDrawer）

| 测试项 | 预期 |
|---|---|
| 创建模板 | name + subject + body 保存 |
| 模板变量 | `{{kol.name}}` 等占位符在预览正确替换 |
| 删除模板 | 二次确认 |

### 9.2 A/B 变体

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 添加变体 | 模板下加 variant B、C | 列表显示变体 |
| 分流发送 | 批量 send 启用 split | 后端按比例选 variant |
| 统计 | 看 stats 页 | 显示每个 variant open/click/reply rate |
| Promote winner | 点击「Promote winner」 | 该 variant 升为主模板 |
| Winner UX 提示 | 数据足够时 | UI 高亮 winner 并显著标识置信度 |

---

## 10. Mailbox 账号 & 邮件发送（`/connections`）

### 10.1 Gmail OAuth

| 测试项 | 步骤 | 预期 |
|---|---|---|
| 授权 | 点 Connect Gmail → OAuth | 回调成功，账号入 `mailbox_accounts` |
| 加密存储 | 查 DB | `credentials_encrypted` 非明文 |
| Token 刷新 | 模拟 access_token 过期 | `onCredsRefreshed` 自动写回 DB |
| 发邮件成功 | 用该 mailbox 发 | 收件人收到，From 是 Gmail 邮箱 |

### 10.2 自定义 SMTP / DNS

| 测试项 | 预期 |
|---|---|
| SMTP 凭据保存 | 加密入库 |
| DNS 验证 | DKIM/SPF/DMARC 检查 |
| 验证失败 | 提示具体哪条记录缺失 |
| Resend 默认发件箱 | 不绑 mailbox 时 fallback 走 Resend `contact@market.hakko.ai` |

### 10.3 社交平台 OAuth

| 平台 | 测试 |
|---|---|
| Instagram | OAuth 接入、token 入库 |
| TikTok | 同上 |
| YouTube | 同上 |
| 断开 | 一键 disconnect 清 token |

---

## 11. Content Studio（`/studio`）

| 子模块 | 测试项 | 预期 |
|---|---|---|
| Text | prompt → Generate | LLM 流式输出（如有 SSE）/ 一次性返回；可编辑、保存 |
| Visual | prompt → Generate image | 返回图片 URL，可下载 |
| Voice | prompt → TTS | 返回音频文件，可播放 |
| Video | prompt → Generate | 返回视频或队列任务 ID |
| Brand voice 应用 | 选 Brand Voice 模板 | 生成内容风格匹配 |
| pgvector 相似检索 | （Sprint 2 D3）选关联的 brand voice | 按 embedding 相似度选最相关 voice 片段 |

---

## 12. Calendar / Publisher（`/calendar`）

| 测试项 | 预期 |
|---|---|
| 显示已排期内容 | 日历视图 |
| 拖拽改时间 | 更新 scheduled_at |
| 立即发布 | 调 publisher agent，状态 → published |
| 发布失败 | 状态 failed + 重试按钮 |
| 多平台同步 | 单条内容多平台勾选都成功 |

---

## 13. Community Inbox（`/inbox`）

| 测试项 | 预期 |
|---|---|
| 邮件 inbound 显示 | Resend webhook 触发后即时出现（或刷新见） |
| 社媒评论拉取 | 已连平台拉取最新评论 |
| 回复评论 | 通过对应平台 API 发出 |
| 标记已读 / 完成 | 状态切换持久 |

---

## 14. Ads（`/ads`）

| 测试项 | 预期 |
|---|---|
| 创建 ad campaign | 走 LLM 生成创意 |
| 平台投放（Meta/Google） | OAuth + 投放接口（功能成熟度低，至少 UI 可达，后端报错友好） |
| 预算 / 排期编辑 | 保存生效 |

---

## 15. Translate（`/translate`）

| 测试项 | 预期 |
|---|---|
| 单段翻译 | 输入中→英、英→中，结果合理 |
| 批量翻译 | 上传多条，全部翻好 |
| Brand voice 保留 | 翻译后术语一致 |

---

## 16. Agents（`/agents`）— 18 个 LLM Agents

| Agent | 测试 |
|---|---|
| `discovery` | KOL 找寻 + 评分 |
| `discovery.evals` | 多模型对比 KOL 质量 |
| `kol-outreach` | 邮件 draft 生成（即 Pipeline 在用） |
| `content-text` / `visual` / `voice` / `video` | Studio 在用 |
| `research` | 主题 research 报告 |
| `competitor-monitor` | 竞品监控 |
| `strategy` | 策略推荐 |
| `publisher` | Calendar 在用 |
| `community` | Inbox 在用 |
| `review-miner` | 评论挖掘 |
| `analytics` | 指标解读 |
| `seo` | SEO 优化建议 |
| `ads` | Ads 在用 |
| `translate` | Translate 在用 |

| 通用测试项 | 预期 |
|---|---|
| Agent 列表 | 18 个全部显示 |
| 单次运行 | 输入 → 调 LLM → 返回结果 |
| 成本统计 `/api/agents/cost` | 累计 token + 美元成本 |
| Agent runs 历史 | 时间倒序 |
| 失败可见 | 异常时记录 error，UI 显示 |
| Provider fallback | 主 provider 失败自动换备用（Anthropic → OpenAI → Gemini → 火山方舟） |

---

## 17. Analytics & ROI

### 17.1 Analytics（`/analytics`）

| 测试项 | 预期 |
|---|---|
| GA4 实时流量 | 显示当前在线 |
| 历史 traffic | 按日期范围 |
| 转化漏斗 | 阶段数据 |
| GA4 token 失效 | 友好错误，引导重新连接 |

### 17.2 ROI Dashboard（`/roi`）

| 测试项 | 预期 |
|---|---|
| 漏斗图 | scrape → contact → sent → opened → replied → signed |
| 0 值显示 | 显示 `-` 而非 0 |
| Campaign 切换 | 数据更新 |
| 时间范围 | 7d / 30d / custom |

---

## 18. Data Module（`/data`）

| 测试项 | 预期 |
|---|---|
| 内容库列表 | 已抓取的内容 |
| 爬竞品 | 输入 URL → 抓取入库 |
| GA4 同步 | 手动触发后入库 |
| Feishu 同步 | `POST /api/data/feishu/sync` 成功 |

---

## 19. Users 管理（`/users`，admin/editor）

| 测试项 | 预期 |
|---|---|
| 列出成员 | 当前 workspace 全员 |
| 邀请新成员 | 邮箱已注册 → 直接入 workspace；未注册 → 生成邀请 token + 链接 |
| **自动发邀请邮件**（Sprint 2 新） | 邀请创建后 Resend 自动发邀请邮件，无需手动复制链接 |
| 邮箱已存在更友好提示 | 不再 500，UI 显示「该邮箱已是用户，已加入 workspace」 |
| 修改 role | admin/editor/viewer 切换持久 |
| 移除成员 | 二次确认 |
| 自己不能移除自己 | 按钮禁用 |
| 非 admin 访问 | 403 / 友好拒绝页 |

---

## 20. Workspace Settings（`/workspace/settings`）

| 测试项 | 预期 |
|---|---|
| Workspace 改名 | 保存生效，sidebar 同步 |
| Brand voice CRUD | 创建、编辑、删除 |
| pgvector embedding | brand voice 保存后 `embeddings` 列填充（admin 查 DB 验证） |
| 删除 workspace | 二次确认 + 数据级联删（仅 owner） |

---

## 21. RBAC 权限矩阵

抽样测试每个角色访问关键 API：

| API | admin | editor | viewer |
|---|---|---|---|
| `POST /api/campaigns` | ✅ | ✅ | ❌ |
| `POST /api/pipeline/start` | ✅ | ✅ | ❌ |
| `POST /api/contacts/:id/send` | ✅ | ✅ | ❌ |
| `GET /api/contacts` | ✅ | ✅ | ✅ |
| `POST /api/workspaces/:id/members` | ✅ | ❌ | ❌ |
| `DELETE /api/users/:id` | ✅ | ❌ | ❌ |
| `POST /api/scheduler/tick` | ✅ | ❌ | ❌ |

每行：用对应 role 账号 + curl 或 UI 测，应得 200 或 403。

---

## 22. Job Queue / 后台任务

| Job 类型 | 触发方式 | 预期行为 |
|---|---|---|
| `email.send` | Approve pipeline / Send contact | worker 拿到 → 调 mailAgent → 写 contact.status |
| `email.batch_send` | Batch send | 拆成多个 email.send 子任务 |
| `email.sync_status` | Resend webhook / 定时 | 拉送达/打开/回复 |
| `scheduled_publish.tick` | scheduler | 到时间点自动发社媒 |
| `discovery.*` | KOL discovery 启动 | 异步抓取 KOL |
| `content.*` | Content Studio 重任务 | 异步生成视觉/视频 |

测试要点：
- 服务重启后 pending job 应继续被处理（确认 in-process 队列状态可恢复）
- 单 worker 多 instance 不重复处理（单实例 max-instances=1 是当前约束）
- 失败 job 进入 retry / dead-letter，不阻塞队列

---

## 23. 集成测试（外部依赖）

| 集成 | 测试 |
|---|---|
| **Resend** | `/api/webhooks/resend/events` 收到 delivered/bounced/opened 事件 → DB `email_events` 写入；webhook 签名验证 |
| **Hunter.io** | API 限流时 UI 友好降级；额度用尽提示 |
| **Hunter Email-Finder** | 仅 domain 时调用，结果置信度显示 |
| **Gmail OAuth** | token 过期自动 refresh |
| **GA4** | 一次断连 → 一次重连 → 数据继续 |
| **Apify** | 抓取 job 成功 / 失败两条路径 |
| **Anthropic** | 主 LLM provider，429 / 5xx 回退到 OpenAI |
| **Cloud SQL** | 连接池耗尽时友好降级（不应 500 整个 API） |

---

## 24. 安全 / 多租户隔离回归

每次涉及新 API 的改动，必跑这一节。

### 24.1 工作区隔离

```bash
# 用户 A 创建 campaign X 在 workspace_a
# 用户 B 在 workspace_b
# B 调 GET /api/campaigns/<X的id> 应返回 404 或 403，不能 200
curl -H "Authorization: Bearer <B's token>" \
     -H "X-Workspace-Id: <workspace_b id>" \
     "$BASE/api/campaigns/<X的id>"
```

### 24.2 必查项

- 任何新 SQL 是否带 `workspace_id = ?`（用 `scoped()` helper）
- 跨表 join 每个 join 的表都要带 workspace 校验
- INSERT 必须显式传 workspace_id
- 不能用 `'hakko-q1-all'` 作为 fallback campaign

参考 [`docs/MULTITENANCY.md`](./MULTITENANCY.md) 完整契约。

### 24.3 公开端点白名单

只有这些端点可不带 workspace（在 `WORKSPACE_SKIP_PREFIXES`）：
- `/api/auth/*`
- `/api/invitations/*`（公开接受流程）
- `/api/webhooks/*`
- OAuth callback

新加端点默认就要走 workspace 中间件。

---

## 25. 错误处理 / 韧性

| 场景 | 触发 | 预期 |
|---|---|---|
| API 5xx | 后端崩 | `<ErrorCard>` 显示 + 重试按钮 |
| 网络断开 | DevTools 切 offline | toast 友好错误 |
| LLM 全 provider 挂 | 屏蔽所有 LLM key | UI 显示具体错误，不挂死 |
| 长任务超时 | 大文件生成 | 进度条不卡死，UI 可取消 |
| ErrorBoundary 兜底 | 故意 throw | 显示 fallback UI + Reload + Retry |

---

## 26. 国际化 (i18n)

| 测试项 | 预期 |
|---|---|
| 全局切 EN/ZH | 所有可见文案切换；本地存储持久 |
| 不裸露 key | 找不到任何形如 `nav.conductor` 的字面量 |
| 占位变量 | `{{count}}` 等正确替换 |
| 错误码也有翻译 | `EMAIL_EXISTS`、`REGISTRATION_DISABLED` 都有人话翻译 |
| RTL（未来） | 当前不支持，确认即可 |

---

## 27. 无障碍 (a11y) 抽查

DevTools → Lighthouse → Accessibility，要求 ≥ 90。手测：

- [ ] 所有 icon 按钮 hover 有 tooltip
- [ ] 所有 form input 有 label（或 aria-label）
- [ ] Tab 键能依次到达所有交互元素
- [ ] Modal 打开自动聚焦第一个交互元素
- [ ] Modal ESC 可关
- [ ] 错误信息 `role="alert"` 屏幕阅读器朗读
- [ ] 颜色对比度满足 WCAG AA（暗色背景 + 白字达标）

---

## 28. 性能基准

- 首屏加载 < 3s（生产 + 4G）
- 路由切换 < 500ms（lazy chunks 加载完后）
- API p95 < 1s（除 LLM / discovery 类长任务）
- DevTools → Network → 单页请求总数 < 50

---

## 29. 烟测脚本（每次 deploy 后必跑）

```text
1. 登录 wangharp@gmail.com
2. 进 /conductor，跑 1 个 preset goal，看到 plan 流出
3. 进 /campaigns，进入一个 campaign
4. 进 /pipeline，看到现有 jobs，stage 显示正常
5. 进 /contacts，看到列表（无 429 错误）
6. 进 /agents，跑一个 content-text agent，验证 LLM 回复
7. 进 /roi，看到漏斗图、数据非空
8. 切 ZH 再切回 EN，所有页面文案正常
9. 切 workspace（如有多个），数据正确隔离
10. 登出 → 登录回来 → 仍在原 workspace
```

通过=可以发版本通告；失败=回滚或 hotfix。

---

## 30. 回归测试用例（按 sprint 整理）

### Sprint 1 已发布修复

- [ ] **Discovery workspace 隔离**（commit `7c825d7`）— 跑 discovery 时切 workspace，数据不串
- [ ] **Outreach 邮件统一走 LLM**（`44324f9`）— 5 个调用点都走 LLM，无模板裸发
- [ ] **Pipeline approve 进 email.send 队列**（`44324f9`）— 不再绕开 worker
- [ ] **Resend webhook 写 email_events**（`98a0d2d`）— prod webhook 触发后 DB 有记录

### Sprint 2 已发布功能

- [ ] **A/B winner UX**（`4619956`）— winner 高亮 + promote 按钮工作
- [ ] **Hunter Email-Finder**（`4619956`）— 无网站 KOL 也能找邮箱
- [ ] **pgvector 接通**（`4619956`）— brand voice embedding 生成、相似检索可用
- [ ] **邀请邮件自动发**（`98a0d2d`）— 邀请创建后用户收到邮件
- [ ] **/metrics Prometheus**（`98a0d2d`）— `curl https://influencexes.com/metrics` 返回指标
- [ ] **已注册邮箱 UX**（`98a0d2d`）— 邀请已存在用户不再 500

---

## 31. 已知豁免（不在本指南覆盖）

参考 [`docs/memory.md`](./memory.md) §6。下列项目尚未实现/不计入测试通过条件：

- Frontend 自动化测试（Sprint 2 C2 才接入 Vitest + Playwright）
- Sentry 报错监控（Sprint 1 A1 待做）
- OpenTelemetry 追踪（Sprint 1 A2 待做）
- BullMQ 替换 in-process queue（Sprint 1 A3 待做）
- Redis 缓存（Sprint 1 A4 待做）
- 公开注册（产品决策，永不开放）
- Stripe 计费（已删除，永不复活）

---

## 32. 维护约定

- 每个新 sprint 结束后**回顾本指南**，新功能加进对应章节
- 修复 bug 时**新增回归用例**到 §30
- 大重构后**重新跑 §29 烟测脚本**
- 测试发现新坑 → 写进 [`docs/memory.md`](./memory.md) §6

---

**Last reviewed**: 2026-04-27（commit `4619956`，prod revision 见 `gcloud run services describe`）
**Next review**: Sprint 3 启动时
