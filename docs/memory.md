# InfluenceX — Project Memory

> 这份文件是**项目级记忆库** —— 收集那些"如果不写下来，下次会被同样的坑卡住"的事实、决策、历史包袱、生产配置、隐式约定。新一次 Claude Code 会话开工前**先扫一遍**。

> 与 [`CLAUDE.md`](../CLAUDE.md) 的关系：CLAUDE.md 是项目入门 + 强约束；这份是经验沉淀 + 软约束（"知道这个能少走弯路"）。

> 与个人级 auto-memory（在 `~/.claude/projects/...`）的关系：那个是 Claude 自动维护跨会话的 user-specific facts；本文件是项目级、入仓库的事实。

---

## 1. 生产环境关键事实

| 项 | 值 |
|---|---|
| **Domain** | `https://influencexes.com/`（注意是 `es` 不是 `ex.com`） |
| **GCP Project** | `gameclaw-492005` (project number `740114287797`) |
| **Region** | `us-central1` |
| **Service** | `influencex` (Cloud Run) |
| **Cloud SQL Instance** | `influencex-db` (Postgres 15) |
| **Cloud SQL Connection** | `gameclaw-492005:us-central1:influencex-db` |
| **DB user / password** | `postgres` / 见 Secret Manager 的 `DATABASE_URL`（**本地没有 `.env`**，见 §5.5） |
| **Database name** | `influencex` |
| **Image registry** | `gcr.io/gameclaw-492005/influencex:latest` |
| **OAuth callback base** | `https://influencexes.com` |
| **Resend From email** | `contact@market.hakko.ai` |
| **Resend Reply-To** | `market@hakko.ai` |
| **Cloudflare** | DNS + CDN（不挡 Cloud Run 流量） |
| **Memory.md 上次更新** | 2026-08-09 (post `#20`) |

### 1.1 当前 Admin

- **`wangharp@gmail.com`** — `users.role='admin'` + 自有 workspace `admin` 角色（Oratis Kamir's workspace, id `3572f1ed...`）
- 其他 3 个 prod 用户都是 `member`，没有 admin 权限

### 1.2 Cloud SQL 直连

```bash
cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db &
# 然后用任何 pg client 连 localhost:5434
# password 从 Secret Manager 取（本地没有 .env）：
gcloud secrets versions access latest --secret=DATABASE_URL --project=gameclaw-492005
```

**注意**：本地常驻一个 cloud-sql-proxy 指向另一个项目（`dimbluedot:us-central1:luddi-pg`，端口 5433）。我们要的是 5434 端口。

---

## 2. 历史包袱与隐式约定

### 2.1 `hakko-q1-all` 是种子 campaign，不是 fallback

服务器 `seedDemoData()` 在数据库为空时插入 `id='hakko-q1-all'` 的 campaign。**这只是首次启动的演示数据**。

旧代码（pre-`7c825d7`）有多处用 `'hakko-q1-all'` 作为 fallback campaign id —— 这是 bug，会让其他 workspace 的数据"逃逸"到这个全局演示 campaign 下。新代码用 `defaultCampaignForWorkspace(workspaceId)` 取替。

**记忆**：以后看到 `hakko-q1-all` 出现在新代码的 fallback 路径，立即质疑。

### 2.2 双 DB 驱动 — `usePostgres` 不是装饰

`server/database.js` 在 `DATABASE_URL.startsWith('postgresql://')` 时用 `pg`，否则用 `better-sqlite3`。意味着：
- 写 SQL 时要用**两个驱动都支持的方言**
- 不能用 Postgres-only 语法（如 `RETURNING *`、`ON CONFLICT`、`ALTER TABLE ... ALTER COLUMN`）除非 wrap `if (usePostgres) { ... } else { ... }`
- `2026-04-19-sso-billing-blog` migration 曾经因为 SQLite 不支持 `ALTER COLUMN ... DROP NOT NULL` 而炸全测试套件，后来加了 `usePostgres` 分支（见 `STATUS_AND_GAPS.md` §4.1 历史）

**记忆**：新建 migration 时跑两次：`SQLite npm test` + `psql against staging`（虽然没有 staging，但至少手测下 prod 重启不报错）。

### 2.3 `email_events` 表曾被两个 migration 创建过

`5aff917`（本地 outreach upgrade）创建 schema A；origin PR `a566132`（Resend webhook）的 migration 创建 schema B 并加 ALTER。rebase 后两个都在 `MIGRATIONS` 数组里 —— schema A 先建表，schema B 的 `CREATE INDEX ON ... provider_email_id` 失败因为列不存在。

**修复**：commit `47c05f8` 删掉了 origin 的 `2026-04-24-email-events` migration。现在只有 schema A（`provider_message_id` 字段名，没有 `provider_email_id`）。

**记忆**：runtime 代码（webhook handler）用 `provider_message_id`。如果以后看到 `provider_email_id` 出现，那是历史残留，要清掉。

### 2.4 `subscriptions` 表是 dormant

来自已删除的 Stripe 计费功能（commit `bccfdde`）。表还在数据库里（删表会破坏 migration 幂等性），但代码不再查它。**不要复活它**，除非有明确产品决策。

### 2.5 `pipeline_jobs` 与 `contacts` 的双向同步

两条邮件流程曾各自独立：
- Pipeline flow：`pipeline_jobs.stage`（scrape → write → review → send → monitor）
- Contact flow：`contacts.status`（draft → pending → sent → delivered → opened/replied）

`44324f9` 之后**unified**：
- `runPipeline` 在 write 阶段创建 `contacts` 行，写 `pipeline_jobs.contact_id`
- `/api/pipeline/jobs/:id/approve` 不再同步发邮件，而是 push `email.send` job
- `email.send` worker 反向同步 `pipeline_jobs.stage`（成功 → monitor，terminal 失败 → review）

**记忆**：不要在 approve 路径再 fork 出第三套发送逻辑。如果要扩展邮件功能（比如多收件人），改 worker。

### 2.6 邀请流程的两条路径

`POST /api/workspaces/:id/members` 接受邮箱，**branches**：
- 如果该邮箱 `users` 表已存在 → 直接 INSERT INTO `workspace_members`
- 如果不存在 → INSERT INTO `invitations`（带 token），返回链接给 admin

第二条路径出口是 `POST /api/invitations/:token/accept`（公开）—— 创建 user + 加 workspace + 自动登录。

**记忆**：不要在 admin 邀请 UI 之外重新实现注册路径；不要让 `/api/auth/register` 复活（它现在 410 Gone）。

### 2.7 `mailAgent.sendEmail` 签名变更

旧签名：`sendEmail({ to, subject, body, fromName, workspaceId, replyTo })` —— `workspaceId` 用来从 `platform_connections` 取 Gmail token。

新签名（rebase 后保留的）：`sendEmail({ to, subject, body, fromName, mailboxAccount, onCredsRefreshed })` —— `mailboxAccount` 是 `mailbox_accounts` 表的整行（带加密 credentials）。

**`workspaceId` 参数会被静默忽略**。如果在新代码看到调用者传 `workspaceId`，那是 bug。`/api/pipeline/jobs/:id/approve` 之前就栽在这里，已修。

### 2.8 i18n 字典是单文件

`client/src/i18n.jsx`（~2900 行）一文件包两套字典 + Provider + hook。改 key 时**两个 locale 都要加**。漏一个的话页面会显示 key 名（如 `auth.invite_only_note`）而不是文案。

### 2.9 用户 i18n key 命名约定

- 路径分隔用 `.`，每段 snake_case
- 顶层分组按页面/模块：`auth.*`, `nav.*`, `common.*`, `pipeline.*`, `contacts.*` 等
- 共用文案放 `common.*`
- 错误码翻译放 `common.error_*`
- 占位变量在双花括号 `{{var}}` 里

---

## 3. 架构决策记录（ADR-style，简版）

### 3.1 Why HashRouter not BrowserRouter

`/#/path` 形式 —— 因为 Cloud Run + Cloudflare 配置下，BrowserRouter 需要服务器端 catch-all rewrite，HashRouter 不需要。代价：URL 不那么"漂亮"。SEO 不重要（B2B SaaS 主入口是 landing page，已是普通路径）。

### 3.2 Why no SSR / Next.js

InfluenceX 是登录后的工具站，公开页面只有 LandingPage。没有 SEO 需求，没有性能瓶颈。Vite SPA + Express 双向独立部署比 Next.js monorepo 简单 50%。

### 3.3 Why custom job queue not BullMQ

历史原因：早期单实例 Cloud Run（max-instances=1），in-process 队列简单可靠。现在已经撑不住了 —— Sprint 1 task A3 会迁到 BullMQ。

### 3.4 Why no Redis (yet)

同上。Sprint 1 task A4 会引入 Redis（Memorystore），同时迁移 cache + rate-limit。

### 3.5 Why no ORM

Raw SQL 让我们把多租户隔离逻辑显式写在每个查询里（用 `scoped(workspace.id)` helper）。Prisma / Drizzle 的"自动生成 WHERE"反而容易留缝。代价：CRUD 重复代码多。

### 3.6 Why ZH + EN, not full i18n framework

i18next、react-intl 等成熟框架对当前规模（2 语言、~500 keys）过重。手写 `t(key, vars)` 总共 30 行代码就够。当 key 数量超过 2000 或语言超过 4 个时考虑迁移。

### 3.7 Why pgvector enabled but unused

migration `2026-04-22-brand-voice-embeddings` 已建索引，`brand_voices.embedding` 列可写，`llm.embed()` 可调，但**目前没有 agent 实际用它做相似度检索**。Sprint 2 task D3 会接通到 content-text agent。

---

## 4. 配置陷阱

### 4.1 `deploy.sh` 的 `^##^` 多分隔符

`gcloud run deploy --update-env-vars` 默认用 `,` 分隔变量。但 `CORS_ORIGINS=https://a.com,https://b.com` 内部就有逗号 —— 会被错误切分。

`deploy.sh` 用 `^##^` 前缀切换分隔符为 `##`，所以变量字符串形如：
```
^##^BASE_PATH=##NODE_ENV=production##CORS_ORIGINS=https://a.com,https://b.com##...
```

**记忆**：改 `deploy.sh` 的 `ENV_VARS` 变量时**保留 `^##^` 前缀**和每行结尾的 `##\` 续行。

### 4.2 Secret Manager API 必须先启用

`gcloud run deploy --update-secrets` 引用 secret 之前，**Secret Manager API 必须在该 GCP 项目启用过**。第一次部署时会报：

```
Cannot update environment variable to the given type because it has already been set with a different type.
```

或：

```
Secret Manager API has not been used in project 740114287797 before or it is disabled.
```

**修复路径**：跑一次 `./setup-secrets.sh`（它内部调 `gcloud services enable secretmanager.googleapis.com`）。idempotent，重跑安全。

### 4.3 env → secret 同名变量类型冲突

如果某变量曾以**明文 env**形式部署过（`--update-env-vars=FOO=bar`），后来想改成 secret 引用（`--update-secrets=FOO=foo-secret:latest`），Cloud Run 会报错说"can't change type"。

**修复路径**：跑一次 `./migrate-env-to-secret.sh` 显式 `--remove-env-vars=FOO,...` 清空，再 redeploy。idempotent。

### 4.4 Cloud Run env 设置不增量

`--update-env-vars="FOO=bar,BAZ=qux"` **替换全部**，不在已有基础上增加。所以 `deploy.sh` 必须把所有非敏感 env 都列在 `ENV_VARS` 里 —— 不然下次 deploy 旧的 env 会消失（这就是为什么 `2728811` 必须把 17 个非敏感 env 全部列出来）。

---

## 5. 工具与命令

### 5.1 本地 SQLite 沙盒（不污染 prod）

```bash
mv .env .env.prod-backup     # 隐藏 prod env
# 写一份只含必要 API key 的 .env
preview_start influencex     # server 走 SQLite fallback
preview_start influencex-client
# ... 测完
rm .env && mv .env.prod-backup .env   # 还原
```

**注意**：preview_start 会读 `.env` 但本地路径不会触发 cloud-sql 连接（除非 DATABASE_URL 是 postgresql://）。

### 5.2 跑单个测试

```bash
node --test server/__tests__/email-jobs.test.js
node --test --test-name-pattern "specific test" server/__tests__/*.test.js
```

`npm test` 跑全套服务端测试，~1 秒（`c7c7d5b` 时约 680 个 / 71 个文件）。前端另有 vitest（`cd client && npx vitest run`）+ Playwright（`npx playwright test`）。

**不要在文档里写死测试数量。** 上面这个数字只是个量级参考，带 commit 才有意义 —— 每合一个带测试的 PR 它就过期一次。#26 刚把 5 处 `234`/`377`/`656` 改成当时正确的 `678`，#28 一合并就又变成 679。**要准确数字就现跑一次**，别引用文档里的。

**`SQLITE_BUSY` 偶发失败不是你的改动坏了。** `npm test` 是 `node --test`，默认按文件并发，而整套测试共用仓库根目录的**同一个** `influencex.db`。并发写会随机让 2-5 个文件报 `{ code: 'SQLITE_BUSY' }`，每次挂的文件还不一样。判定方法：

```bash
node --test --test-concurrency=1 server/__tests__/*.test.js   # 串行，~8 秒，全绿
```

串行绿 = 并发那几个是 flake。串行也红才是真的坏了。（在 main 上空跑也能复现，与任何 PR 无关。）

### 5.3 客户端 build 检查

```bash
cd client && npx vite build   # 输出 client/dist/
```

build 失败通常是：
- 删了某个 i18n key 但还有 `t('key')` 调用 —— 不会真挂，会运行时显示 key 名
- 真的 type / import 错误 —— 立即修

### 5.4 看 prod 日志

```bash
gcloud run services logs read influencex --region=us-central1 --limit=50 --project=gameclaw-492005
```

Sentry（`server/sentry.js`，客户端自 `891f209`）与 OpenTelemetry（`server/otel.js`，自 `8f00ad1`）**都已接入** —— 需要 `SENTRY_DSN` / OTLP endpoint 环境变量才会真正上报。没配的话仍然只能 grep Cloud Run 日志。

### 5.5 prod DB 一次性查询

```bash
cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db &
node -e "
const { Client } = require('pg');
const c = new Client({ host: 'localhost', port: 5434, user: 'postgres', password: '<见下方 gcloud 命令>', database: 'influencex' });
c.connect().then(async () => {
  const r = await c.query('SELECT ...');
  console.log(r.rows);
  await c.end();
});
"
kill %1
```

**写之前永远先查**。已经因为这个救过自己一次（admin 升级查询前先列了所有 user 验证哪个是管理员）。

---

## 6. 已知 bug（不阻塞但要记得）

> **2026-08-09 全量更新** —— 一次全局 e2e review + 15 个 PR（#6–#20）关闭了下表大部分历史条目。完整对照见 [E2E_REVIEW_2026-08.md](./E2E_REVIEW_2026-08.md) 与 [MASTER_PLAN_2026-08.md](./MASTER_PLAN_2026-08.md)。

### 已关闭

| 原条目 | 关闭方式 |
|---|---|
| 无 frontend 测试 | 13 个文件 / 82 个 vitest + 5 条 Playwright，全部挂 CI（#12/#13） |
| 无 Sentry / OTEL | 早已接入；依赖冲突后遗症 #7 收尾 |
| In-process job queue 多副本丢消息 | BullMQ API 修复 + 发送原子抢占 + 进程级异常兜底（#10） |
| pgvector 启用但 agent 没用 | 实际是**接了但从未工作**（embed 调用契约错，`findBestBrandVoice` 永远返回 null）→ #20 修复。**2026-08-09 查过 prod：`brand_voices` 表 0 行**，所以坏了这么久也没丢数据，不需要 backfill |
| ContactModule 5s 轮询撞 429 | 后台刷新不再置 loading + 请求序号守卫（#9）；限流器桶隔离（#15） |
| Hunter API 仅对有外链网站的 KOL 有效 | 仍然成立，但已是产品决策（付费 API 预算）而非 bug |

### 仍然成立 / 新增

| Bug | 影响 | 备注 |
|---|---|---|
| `subscriptions` 表 dormant | 占空间 | 永不修 |
| **无邮件服务商时 approve 卡在 `stage='send'`** | 未配 Resend/SMTP 的部署，审批过的任务永远到不了 monitor | dry-run 分支在同步 pipeline 前就 return；#12 的测试如实断言了现状 |
| **`generateOutreachEmail` 不计入用量账本** | 最高频 LLM 路径的花费不可见 | 签名不带 workspaceId，需穿过 5 个调用点 |
| **前端未按权限隐藏控件** | viewer 会看到点不动的按钮并收到 403 toast | #14 的 RBAC 只做了服务端 |
| **SSE token 走 query string** | 会进服务端/代理日志与浏览器历史 | 两个流端点都受影响，需一次性 stream ticket |
| **DNS-rebinding SSRF** | 公网域名解析到内网 IP 仍可通过 | `assertSafeUrl` 是字面主机检查，需 resolve-then-pin |
| **既有明文 platform token 未回填加密** | 历史行仍是明文 | 读时透明兼容、下次写入才加密 |
| `content_daily_stats` 全局 UNIQUE(content_url, stat_date) | 跨工作区同 URL 同日第二条快照被静默跳过 | fail-closed，彻底解决需改约束 |
| Marketplace 无下架/申诉流程 | 撤一条 listing 只能手工 DELETE | provenance 列可定位，需配合创作者 opt-out |
| **design.md 与现状脱节** | §10.3 说焦点还原未实现、§12 硬编码 FUNNEL_COLORS、§8.3 modal 契约现已是组件 | #13 之后未同步 |
| **brand voice 只在创建时写 embedding** | 以后加编辑接口会留下过期向量 | `POST /api/brand-voices` 是唯一写点（`server/index.js:3419`），目前只有 GET/POST/DELETE，没有 update 路由所以暂时无害 |
| `ContactModule.jsx` 与 `PipelinePage.jsx` UI 重复 | 两个 page 显示相似数据 | 未评估 |

### 这轮学到的、值得记住的失效模式

1. **静默错配比崩溃危险**：引用不存在的 CSS token（ErrorCard 白底白字）、不存在的 class（`className="input"` 原生控件）、错误的函数契约（`llm.embed` 永远返回 null）——三者都不报错，只是安静地渲染成错的样子或永远返回空。**"看起来像空状态"要当成 bug 线索查。**
2. **只在新库上测 = 测不到生产**：session 索引写进基础 schema，全新库没问题，已有库启动即死。563 个测试全绿也拦不住。**改 schema 必须在有数据的库上启动一次。**
3. **列可空 = 隐形数据丢失**：`workspace_id` 一直 nullable，任何忘记带它的 INSERT 都静默成功、然后从所有 scoped 读里消失。#11 用条件 NOT NULL 做了结构性根治。
4. **源码里的裸控制字节 = 文件从 review 里消失**：`usage-ledger.js` 的复合键分隔符是直接写进源码的裸 `0x00`，而不是 `\u0000` 转义。NUL 一旦落在文件前 8000 字节内，git 就把**整个文件**判成二进制 —— `git diff` 只剩 `Bin N -> M bytes`，`git blame` 彻底失效。**它不需要谁疏忽：任何一个会吞反斜杠转义的管线都能产生它，而且产生之后会把自己藏起来。** #30 修了这个实例（#27 是同一修复的重复 PR，已 close），`.gitattributes` 的 `diff` 属性做了结构性兜底（对 NUL 文件也强制文本 diff）。**在全量 diff 里看到源码文件显示 `Bin`，立刻当 bug 查。**

## 7. 与协作者的协议

### 7.1 不要触碰别人的工作

如果 build 失败因为某个新 model / 新 API endpoint / 新 component —— **先问，再删**。可能是另一个会话/开发者的并行工作。

### 7.2 commit message 风格

参考 git log 里 `7c825d7` / `44324f9` / `fa692ca` 这些近期 commit。格式：

```
<type>(<scope>): <短句>

<段落 1: 上下文 / 为什么改>

<段落 2: 改了什么>
- 项 1
- 项 2

<段落 3: 验证情况>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

type: `feat` / `fix` / `chore` / `docs` / `refactor`。scope: `discovery` / `outreach` / `auth` / `deploy` 等。

### 7.3 deploy 节奏

- 小改动（i18n / 文案 / a11y） —— 不强求立刻 deploy，下次大改一起
- bug 修复 —— 立即 deploy（push + run `./deploy.sh`）
- 安全修复 —— 立即 deploy + 通知用户
- 大重构 —— 至少跑过全套服务端测试（全绿，不是"大部分绿"）+ 客户端 build + 本地 preview 烟测，再 deploy

### 7.4 push 前 checklist

- [ ] `npm test` 全绿
- [ ] `cd client && npx vite build` 通过
- [ ] git diff 自审一遍
- [ ] commit message 包含 "why"，不只是 "what"
- [ ] 涉及 API 变更的话 `docs/MULTITENANCY.md` 是否还匹配
- [ ] 涉及新 ENV / SECRET 的话 `.env.example` + `setup-secrets.sh` + `deploy.sh` 同步

---

## 8. 不要做的事（强约束）

1. **不要 `git push --force` 到 main** —— 永远先 PR 或先确认
2. **不要把 `.env` 推到 git** —— 已 .gitignore，但确认
3. **不要在新代码里 `console.log`** —— 用 `server/logger.js` 的 `log.debug/info/warn/error`
4. **不要在 prod DB 直接 UPDATE / DELETE** —— 至少先 SELECT 验证
5. **不要 fork 出新邮件发送路径** —— 走 `email.send` job queue
6. **不要在新代码里硬编码 `'hakko-q1-all'`** —— 用 `defaultCampaignForWorkspace()`
7. **不要复活 Stripe / billing 路由** —— 产品决策已删
8. **不要在 `runPipeline` 调用时漏传 `workspaceId`** —— 5 个参数全部都要
9. **不要让公开注册回来** —— `/api/auth/register` 永远返回 410
10. **不要在 ErrorBoundary 之外的地方 throw** —— 所有 React 异常应被边界捕获

---

## 9. 持续维护

这份 memory.md 应该**随项目演进持续追加**：
- 修了一个让人困惑的 bug → 加进 §6 已知 bug
- 做了一个有争议的架构决策 → 加进 §3 ADR
- 踩了一个 Cloud Run / GCP 坑 → 加进 §4 配置陷阱
- 改了一个隐式约定 → 更新 §2 历史包袱

约定：每个 sprint 结束时整理一次。当前 review 节点：**Sprint 1 结束时（2 周后）**。

---

**Last reviewed:** 2026-08-09 (post `#29` / `c7c7d5b`, main green: server 679 serialized / client 82 / e2e 5).
Prod revision unchanged since `00049-w2x` — **this batch has not been deployed yet**; see
[MASTER_PLAN_2026-08.md](./MASTER_PLAN_2026-08.md) §5 for the pre-deploy checklist (the startup
contract changed: MAILBOX_ENCRYPTION_KEY now fail-fast, webhooks fail-closed without secrets).
