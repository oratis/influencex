# InfluenceX 管理员账号 / 邀请码功能配置指南

> **写给谁看**：平台运维、想验证邀请码功能的开发、需要管理员账号的内部用户。
> **关联文档**：邀请码功能的端到端使用流程见 [USER_MANUAL.md §6.2](./USER_MANUAL.md)。

---

## 1. 现有管理员账号

### 1.1 生产环境（influencexes.com）

| 字段 | 值 |
|---|---|
| **邮箱** | `wangharp@gmail.com` |
| **角色** | `users.role = admin`（平台级管理员） + 自有 workspace `admin`（工作区级管理员） |
| **密码** | 见原始管理员私下保管，不在代码 / 仓库中明文 |
| **登录方式** | https://influencexes.com/#/login（邮箱密码 或 Google SSO） |
| **能做什么** | 全部功能，包括 Invite Codes 管理 |

> **重要**：此账号密码若忘记，可通过下面 §3 的「密码重置」恢复 —— 但只能由有 Cloud SQL 写权限的运维操作。**不要**在 git 提交、私聊、Slack 中明文流通密码。

### 1.2 本地开发 / 沙盒环境

按需自行 bootstrap，见 §2。

---

## 2. 在本地 / 新环境创建管理员账号

### 2.1 通过 ENV 自动创建（推荐 — 已支持自动促升 admin 角色）

在 `.env` 中加：

```bash
ADMIN_EMAIL=admin@influencex.local
ADMIN_PASSWORD=Admin12345
ADMIN_NAME=Local Admin
```

启动服务器：

```bash
preview_start influencex
# 或：node server/index.js
```

启动时日志会出现：

```
Default admin account created: admin@influencex.local
```

或（如果用户已存在）：

```
Promoted admin@influencex.local to admin role
```

之后用配置的邮箱密码登录即为平台管理员（`users.role = admin`），可看到侧栏 **Invite Codes** nav 项。

> **本地沙盒 admin 凭据建议**：
> - Email: `admin@influencex.local`
> - Password: `Admin12345`
>
> **不要在生产环境用这套弱密码**。生产 admin 用真实邮箱 + 强密码。

### 2.2 通过 demo seed 脚本创建

```bash
node server/seed-demo.js
```

会创建：
- Email: `demo@influencex.dev`
- Password: `demo1234`
- 角色: `users.role = admin`
- 顺带 seed 12 个示例 KOL + 2 个示例 campaign

适合演示 / 快速测试，不适合生产。

### 2.3 手动 SQL 创建（应急 / 高级）

连数据库（SQLite 本地：`data.db`；Postgres 生产：cloud-sql-proxy → port 5434）：

```sql
-- 1. 注册 user（密码用 bcrypt hash 后填，不能直填明文）
-- 用 Node.js 生成：
--   require('bcryptjs').hashSync('YourPassword', 10)
INSERT INTO users (id, email, password_hash, name, role)
VALUES (
  '<uuid>',
  'admin@yourdomain.com',
  '$2a$10$<bcrypt hash>',
  'Your Name',
  'admin'
);

-- 2. 给该 user 一个 workspace（如不存在）
INSERT INTO workspaces (id, name, slug, owner_user_id, plan)
VALUES ('<ws-uuid>', 'Your Workspace', 'your-ws-<short-uuid>', '<user-uuid>', 'starter');

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('<ws-uuid>', '<user-uuid>', 'admin');
```

---

## 3. 密码重置（生产）

**前提条件**：本地能跑 `cloud-sql-proxy` + 知道 Cloud SQL 密码。

```bash
# 1. 起 proxy
cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db &

# 2. 生成新 hash
node -e "console.log(require('bcryptjs').hashSync('NewStrongPassword123', 10))"
# 复制输出（形如 $2a$10$...）

# 3. 更新 prod
node -e "
const { Client } = require('pg');
const c = new Client({
  host: 'localhost',
  port: 5434,
  user: 'postgres',
  password: '<.env DATABASE_URL 里的密码>',
  database: 'influencex',
});
c.connect()
  .then(() => c.query(\"UPDATE users SET password_hash = \$1 WHERE email = \$2 RETURNING id, email\", ['$2a$10$<新 hash>', 'wangharp@gmail.com']))
  .then(r => { console.log('updated:', r.rows); return c.end(); });
"

# 4. 关 proxy
kill %1
```

**注意**：
- **永远不要** 把 prod 数据库密码写进任何 commit
- 修改后通知账号持有者（邮件 / Slack DM）
- 不要在共享会话 / 截图中暴露 hash

---

## 4. 邀请码功能（新加入功能）说明

### 4.1 功能概览

邀请码（Invite Codes）是平台**新增**的注册路径：

| 旧路径（per-email） | 新路径（invite code） |
|---|---|
| 管理员输入对方邮箱 → 系统生成 token + 链接 → 链接发对方 | 管理员生成通用代码（`INFLX-XXXXXXXX`） → 任何持码者可注册 |
| 一对一定向、单次使用 | 一对多批量、可设次数（1-1000） |
| 在 Workspace Settings → Members 创建 | 在 Invite Codes 页创建（仅平台管理员可见） |

### 4.2 谁能创建邀请码

**仅 `users.role = 'admin'` 的平台级管理员**。这与 workspace-级 admin 不同：
- workspace admin（仅 admin of one ws）→ **不能** 创建 invite code
- platform admin（`users.role = 'admin'`）→ 能创建 invite code，且可指定任意 workspace

### 4.3 创建邀请码的步骤

1. 用 platform admin 账号登录
2. 侧栏点 **Invite Codes**
3. 填写表单：
   - **Target workspace**（目标工作区）：新用户加入哪个 workspace
   - **Default role**（默认角色）：新用户加入后的工作区角色（admin / editor / viewer）
   - **Max uses**（最大次数）：1-1000
   - **Expires (days)**（过期天数）：1-365；留空表示永久有效
   - **Note**（备注）：内部记录用，如 "Q2 partner batch"
4. 点 **Generate code** → 系统生成形如 `INFLX-PS7TYXR4` 的码
5. 列表中点 **Copy code** 或 **Copy link** 分享给目标用户

### 4.4 邀请码状态

| 状态 | 含义 | 触发 |
|---|---|---|
| **Active**（可用） | 还能用 | used_count < max_uses 且未过期未撤销 |
| **Exhausted**（已用完） | 达到使用上限 | used_count >= max_uses |
| **Expired**（已过期） | 超过 expires_at | NOW > expires_at |
| **Revoked**（已撤销） | 管理员手动撤销 | 点 Revoke 按钮 |

非 active 状态的码无法被新用户使用（lookup 时会返回明确错误码）。

### 4.5 用户怎么用邀请码注册

1. 用户访问 https://influencexes.com/#/signup（或带码链接 `/#/signup?code=INFLX-XXXXXXXX`）
2. 输入邀请码 → 点 **Continue**
3. 系统校验 → 显示「将以 XX 角色加入 XX 工作区，剩余 N 次」
4. 填邮箱 + 密码 + 姓名 → 点 **Create account**
5. 自动登录，跳到 `/pipeline`

### 4.6 API 端点参考

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/api/invite-codes` | platform admin | 创建邀请码 |
| `GET` | `/api/invite-codes` | platform admin | 列表所有邀请码 |
| `DELETE` | `/api/invite-codes/:id` | platform admin | 撤销邀请码 |
| `GET` | `/api/invite-codes/lookup/:code` | 公开（无需登录） | 校验码（仅返回 workspace 名 + 剩余次数，不暴露详情） |
| `POST` | `/api/auth/register-with-code` | 公开（无需登录） | 用码注册新账户 |

### 4.7 数据库表

```sql
-- 邀请码主表
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- "INFLX-XXXXXXXX"
  workspace_id TEXT NOT NULL,         -- 目标 workspace
  role TEXT NOT NULL DEFAULT 'editor',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP,               -- nullable = 永久
  revoked_at TIMESTAMP,               -- nullable = 未撤销
  note TEXT,
  created_by TEXT NOT NULL,           -- 创建管理员 user.id
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 兑换审计
CREATE TABLE invite_code_redemptions (
  id TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

迁移文件：
- `2026-04-27-invite-codes` — 主表
- `2026-04-27-invite-code-redemptions` — 审计表

### 4.8 安全注意

- **邀请码就是注册凭据** —— 泄露给外人 = 任何人能注册并加入指定 workspace
- 推荐 **每批合作 / 招募分别生成独立码**，方便定向撤销
- 设置合理的 `max_uses` + `expires_at`，不要默认无限期
- 撤销 = 软删（保留审计），码立刻失效但记录还在
- `users.role = 'admin'` 检查在每个 invite-codes API 端点显式做（非 RBAC permissions 表）—— 防止 workspace admin 越权

### 4.9 如何检查 prod 邀请码使用情况

```bash
cloud-sql-proxy --port 5434 gameclaw-492005:us-central1:influencex-db &

node -e "
const { Client } = require('pg');
const c = new Client({ host: 'localhost', port: 5434, user: 'postgres', password: '<env>', database: 'influencex' });
c.connect().then(async () => {
  const r = await c.query(\`
    SELECT ic.code, ic.used_count, ic.max_uses, ic.expires_at, ic.revoked_at, ic.note,
           w.name AS workspace, u.email AS created_by
    FROM invite_codes ic
    LEFT JOIN workspaces w ON ic.workspace_id = w.id
    LEFT JOIN users u ON ic.created_by = u.id
    ORDER BY ic.created_at DESC
  \`);
  console.table(r.rows);
  await c.end();
});
"

kill %1
```

---

## 5. 部署后的 Smoke Test

部署完邀请码功能后跑这 5 步：

```text
1. 用 platform admin 登录
2. 进 Invite Codes 页 — 看到表单 + 空列表
3. 填表单 → 创建一个码（max_uses=2, expires=7d）
4. 复制码 → 在隐身窗口打开 /#/signup?code=INFLX-XXXXXXXX
5. 完成注册 → 应自动登录到 /pipeline
6. 回管理员账号刷新 Invite Codes — used_count 应变成 1
7. 撤销该码 → 状态变 Revoked
8. 隐身窗口尝试再用同码注册 → 应返回 "Invite code revoked"
```

通过 = 功能正常。

---

## 6. 与现有功能的兼容性

| 旧功能 | 兼容情况 |
|---|---|
| `/api/auth/register` | 仍 410 Gone，提示用 `/signup` 或邀请链接 |
| `/api/invitations/:token/accept`（per-email 邀请） | 完全保留，正常工作 |
| Workspace Settings → Invite Member | 完全保留，UI 不变 |
| 现有用户登录 | 不受影响 |
| RBAC permissions | 邀请码 API 用 `users.role` 直查，不读 RBAC 表 |

---

## 7. 已知限制

- **没有 GUI 编辑邀请码** —— 一旦生成，max_uses / expires_at 不能改（要改先 revoke 再建新码）
- **没有码分组 / 标签** —— 用 note 字段记录，前端列表过滤未做
- **没有 IP 限流** —— `/api/auth/register-with-code` 走通用 authLimiter；如果担心被脚本批量扫码可在 Cloud Run / Cloudflare 加额外限制
- **没有码使用历史界面** —— 看 `invite_code_redemptions` 表需要直连 DB

后续 Sprint 可考虑补充上述。

---

**Last updated**: 2026-04-27（feature 加入 commit 后）
