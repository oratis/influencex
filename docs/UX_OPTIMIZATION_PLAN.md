# InfluenceX UX 优化计划（自审 + 推进）

> **来源**：写完 [TESTING_GUIDE.md](TESTING_GUIDE.md) + [USER_MANUAL.md](USER_MANUAL.md) + 落地邀请码功能后的端到端浏览器走查发现的实际痛点。
> **执行原则**：**P0 当轮全部修完**；P1 当轮高价值的也修；P2 列出但延后到下个 sprint。
> **生效 commit**：本轮（基于 `4619956` + invite-codes feature）

---

## 0. 自审发现的痛点（按严重度排序）

### 🔴 P0 — 阻塞 / 困惑新用户，必须当轮修

| # | 现象 | 后果 | 改法 |
|---|---|---|---|
| **P0a** | 新管理员登录后**没有任何 workspace**，所有页面都报 `Workspace context required`，控制台报错刷屏 | 第一印象就是平台坏了 | 登录后自动创建一个默认 workspace（用 user.name 命名） |
| **P0b** | 同上场景下，前端 toast 也持续弹出"Workspace context required" | 烦人且无可操作信息 | 在 401/onboarding 态下静音此 toast，由 onboarding 流程接管 |
| **P0c** | 密码输入框无显隐切换 —— 用户不知道自己打的对不对 | 误输入率高 | AuthPage / SignupWithCodePage / AcceptInvitePage 加 👁 切换按钮 |
| **P0d** | 多处硬编码英文（`App.jsx` Loading / `ConfirmDialog` Close / `LanguageSwitcher` title / `ConnectionsPage` SMTP labels） | 切到中文后仍是英文，体验割裂 | 全走 i18n |
| **P0e** | 首次登录直接落到 `/pipeline`，但新用户没有任何 KOL → 空白页 | 不知道下一步 | 没有 campaign 时改导到 `/conductor`（最佳起点） |
| **P0f** | 创建邀请码后，**新码混在列表中没有视觉强调**，用户得自己找 | 找不到刚生成的码 | 创建成功后弹出"复制 + 分享文案"模态，并高亮 1 行该码 |
| **P0g** | InviteCodesPage 在 workspace 为空时，下拉显示 "—"，没说怎么办 | 用户卡死 | 显示空状态卡片 + "去创建 workspace"链接 |
| **P0h** | AuthPage 的"Have an invite code? Sign up here →"是脆弱链接 —— 视觉权重远低于 Sign In 按钮 | 持码用户找不到注册入口 | 升级为带边框的次操作按钮，与 Sign In 同区位 |

### 🟡 P1 — 当轮做：高频小痛点

| # | 现象 | 改法 |
|---|---|---|
| **P1a** | 邀请码 lookup 失败时只显示英文 fallback `body.error` | 错误码翻译已加（CODE_NOT_FOUND 等），但 `body.error` 兜底没翻译 | 已用 i18n key 兜底 |
| **P1b** | 复制 link 时，URL 里 hash 包含 `?code=` 形式不直观；用户复制后看到 `/#/signup?code=` 觉得奇怪 | 加一个 tooltip 解释 |
| **P1c** | 没有"跳过此 onboarding"逃生口（针对自动创建 workspace） | 不需要 — 用户随时可改名删除 |
| **P1d** | InviteCodes 创建表单提交后，输入仍在原值，下次创建容易重复 | 重置为默认 |

### 🟢 P2 — 列入 backlog，本轮不做

| # | 现象 | 备注 |
|---|---|---|
| P2a | 17 个侧栏项过多 | 需要产品决策分组 |
| P2b | Forgot password 流程缺失 | 需要邮件发送 + token 系统 |
| P2c | 移动端 240px 固定侧栏不响应式 | 大重构 |
| P2d | 缺少 onboarding 引导 tour | 可用 Conductor 替代，等数据 |
| P2e | 全局搜索 | 数据量到一定程度再加 |
| P2f | 表单失败 auto-save 草稿 | 局部需求 |
| P2g | 删除操作的 undo | 大重构（需要 soft-delete） |
| P2h | 长列表分页指示 | 当前页面数据不大，PR 时再处理 |
| P2i | 邀请码可编辑（改 max_uses / expires_at） | 当前重新生成成本低，先观察需求 |

---

## 1. P0 实施计划（按依赖顺序）

### P0a + P0b: Onboarding 状态修复
**位置**：`server/index.js` 的 `initializeDefaultData()` + `client/src/api/client.js` 的 `request()` 错误处理
**做什么**：
1. Server 端：管理员 user 在没有 workspace 时**自动创建一个**（命名 "{name}'s workspace"）
2. Client 端：识别 `Workspace context required` 错误后**不弹 toast**，让 onboarding banner 接管

### P0c: Password 显隐切换
**位置**：3 个 auth 页面 + 1 个 password 字段（在 AcceptInvitePage / SignupWithCodePage / AuthPage）
**做什么**：在 input 右侧加 👁 / 🙈 按钮 toggle `type="password"` ↔ `type="text"`，纯前端

### P0d: 4 处硬编码英文 i18n
**位置**：4 个具体文件
- `client/src/App.jsx:40` — `<p>Loading...</p>` → `t('common.loading')`
- `client/src/components/ConfirmDialog.jsx:45` — `aria-label="Close"` → `t('common.close')`
- `client/src/components/LanguageSwitcher.jsx:13` — `title="Language"` → `t('language.title')`
- `client/src/pages/ConnectionsPage.jsx:489-502` — SMTP Host/User/Password label 改 `t('connections.smtp_host'...)`

加对应 i18n keys（EN + ZH）。

### P0e: First-time landing redirect
**位置**：`client/src/App.jsx` Routes
**做什么**：`/` 重定向逻辑改为：
- 有 campaigns → 还是 `/pipeline`
- 无 campaigns → `/conductor`（更好的起点，让 AI 帮新用户建第一个 plan）

### P0f: 创建邀请码后 share 模态
**位置**：`InviteCodesPage.jsx`
**做什么**：成功后弹一个内嵌 panel 显示码 + 一键复制码 + 一键复制 link + 分享文案模板（中英版）

### P0g: 无 workspace 时的空状态
**位置**：`InviteCodesPage.jsx`
**做什么**：workspace 列表空时不显示创建表单，改显示"先创建 workspace"卡片（点击带去 `/workspace/settings` 或 sidebar workspace switcher）

### P0h: AuthPage 注册按钮
**位置**：`AuthPage.jsx`
**做什么**：
- 把"Have an invite code"从纯文字 link 升级为 `btn btn-secondary auth-submit`（按钮态）
- 视觉上与 Sign In 主按钮**并列**而不是底部小字

---

## 2. P1 实施计划

| Item | 位置 | 做什么 |
|---|---|---|
| P1a | i18n 已 cover，不需改 | — |
| P1b | InviteCodesPage `Copy link` 按钮 tooltip | 解释 link 内容 |
| P1d | InviteCodesPage 表单提交后 | reset note 字段（已做），其它保留方便连发 |

---

## 3. i18n 完整性收尾

完成 P0d 后，再跑一次 audit：
1. EN/ZH 顶层 sections 对齐 ✅（已验证）
2. 每个 section 内 key 对齐 ✅（已验证）
3. 硬编码字面量 → i18n 改完后清零
4. 新增 key 也要双语完整

---

## 4. 验收标准（自检）

修完后用 `admin@influencex.local / Admin12345` 重复以下端到端：

```text
□ 全新登录（无任何 workspace）→ 应看到"Welcome, your workspace was set up automatically"
□ 切换 EN/ZH → 所有可见文字翻译完整，无英文残留
□ 在登录页能看到明显的"Sign up with invite code"按钮（不是底部小链接）
□ 输入密码时有 👁 显隐切换
□ 创建邀请码后，立即看到一个分享面板（含复制按钮 + 模板文案）
□ 用 viewer 角色登录 → /invite-codes 直接显示拒绝页
□ 不再有 "Workspace context required" toast 噪音
□ 控制台无 unhandled error
```

---

## 5. 时间预估 vs 实际

| 项 | 状态 | 备注 |
|---|---|---|
| P0a + P0b（onboarding） | ✅ Done | `ensureUserHasWorkspace` helper + 在 login/me 路径调用；client 静音 toast |
| P0c（password toggle） | ✅ Done | 新建 `<PasswordInput>` 组件，3 个 auth 页面接入 |
| P0d（i18n hardcoded） | ✅ Done | `App.jsx` Loading / `ConfirmDialog` Close / `LanguageSwitcher` title / `ConnectionsPage` SMTP labels 全走 i18n |
| P0e（redirect） | ✅ Done | `<HomeRedirect>` 组件，按 campaign 数量分流 |
| P0f（share panel） | ✅ Done | 创建后顶部高亮 panel，3 个一键按钮（含中英版分享文案模板） |
| P0g（empty state） | ✅ Done | 无 workspace 时显示空状态卡 + CTA 链接 |
| P0h（AuthPage button） | ✅ Done | 升级为 `btn btn-secondary auth-submit` 全宽次按钮 |
| 验证 | ✅ Done | 255 server tests pass + vite build clean + 浏览器端到端验证 EN/ZH |

---

## 6. 后续 Sprint 待办（P2）

会回流到 [`docs/ROADMAP_2026-Q2.md`](./ROADMAP_2026-Q2.md) Sprint 3：

- Forgot password
- 移动端响应式
- 全局搜索
- 邀请码可编辑（不需重建）
- 长列表分页指示
- 软删 + undo
- onboarding tour 组件库

---

**Last reviewed**: 2026-04-27
**Next review**: 推进完成后 + Sprint 3 启动时
