# InfluenceX Design System

> **所有 UI 开发必须遵守本规范。** 本文档是 InfluenceX 视觉与组件的唯一权威指南。

---

## 0. Token 真源（Single Source of Truth）

**Token 数值（hex / 像素 / cubic-bezier）住在代码里，本文档不重复定义值。**

| 平台 | 文件 | 暴露 |
|---|---|---|
| Web | `client/src/index.css` | `:root` CSS 变量（如 `--bg-primary`、`--accent`、`--radius`） |

**规则：** 改 token 数值只动 `client/src/index.css` 的 `:root` 块；本文档只定义"用哪个 token、在哪用、怎么用"。如果你看到 hex 字面量散落在别的 `.jsx` 或 `.css` 中，那是 bug，要把它替换为 `var(--xxx)`。

---

## 1. 设计哲学

### 1.1 核心原则

| 原则 | 含义 |
|---|---|
| **AI First** | 用户不操作工具，而是描述目标。UI 是 AI 的对话窗口、输入面板、审批关卡 |
| **Dark by Default** | 仅暗色主题，纯黑深紫背景，让数据可视化（图表、ROI）"发光" |
| **Information Dense** | 营销人员要看大量数据。允许信息密度高，但用层级 + 间距 + 颜色分区，不靠边框堆砌 |
| **Trust Through Transparency** | 每个 AI 决策（plan、生成的邮件、Ads 策略）必须可见、可编辑、可拒绝。永远不在用户背后操作 |
| **Progress Visibility** | 长耗时操作（Discovery、Conductor plan、邮件批量发送）必须有进度指示，不能空 spinner |

### 1.2 品牌人格

- **专业**（B2B SaaS，对标 Linear / HubSpot 的现代感）
- **AI 原生**（不是"加了 AI 的旧工具"）
- **多文化**（中英文一等公民，目标市场 APAC + 北美）
- **效率工具**（用户每分钟的注意力都很贵）

### 1.3 反模式

❌ **不使用浅灰背景**（任何 `#EEE` / `#CCC` / `light-gray`）—— 暗色主题
❌ **不使用 emoji 作为功能图标**（仅作 decoration / user 内容里允许，按钮 / 状态用 SVG）
❌ **不使用纯白文字**在彩色按钮上 —— 用纯黑 + 高对比，更有质感
❌ **不引入 light mode**（至少 v2.0 之前不做）
❌ **不堆叠多层模态**（最多一层 dialog 之上一层 toast；其他层级用 drawer / inline panel）
❌ **不在 form 里用 placeholder 替代 label**（WCAG 2.1 Level A 红线）

---

## 2. 颜色应用

### 2.1 背景分层

代码里有 5 层背景 token，每层比下一层亮约 4-6%：

```
Layer 0: var(--bg-primary)        — 整页背景
Layer 1: var(--bg-secondary)      — 侧栏 / 顶栏
Layer 2: var(--bg-card)           — 卡片 / drawer / modal
Layer 3: var(--bg-card-hover)     — hover / 选中卡
Layer 4: var(--bg-input)          — input / textarea / select
```

**规则：**
- 不跳层（Layer 0 上直接放 Layer 4 元素失去层次）
- 模态背景统一用 `rgba(0,0,0,0.6)` 遮罩 + Layer 2 卡

### 2.2 主色 (Accent)

主色 token：`var(--accent)`（深紫 `#6c5ce7`） + `var(--accent-hover)` + `var(--accent-light)` (15% 透明度背景)

| 场景 | 用法 |
|---|---|
| **CTA 按钮（主操作）** | `class="btn btn-primary"`（背景 accent，文字纯白）— 一屏最多 1 个 |
| **Active tab / nav** | `border-color: var(--accent)`、文字 accent |
| **链接 / hover 强调** | accent 文字 |
| **进行中状态徽章** | `var(--accent-light)` 背景 + accent 文字 |

### 2.3 状态色

| 状态 | Token | 典型用法 |
|---|---|---|
| Success | `--success` (#00d2a0 cyan-green) + `--success-bg` | 邮件发送成功 toast、KOL 已签约徽章 |
| Warning | `--warning` (#fdcb6e amber) + `--warning-bg` | 配额接近上限、429 限流 |
| Danger | `--danger` (#ff6b6b coral) + `--danger-bg` | 邮件发送失败、bounced contact、删除按钮 |
| Info | `--info` (#74b9ff sky) + `--info-bg` | 普通信息 toast、tooltip |

**规则：**
- 状态色仅用于状态反馈，不用于装饰
- 红色 (`--danger`) 不用作"激活"或"重要"，仅用于错误 / 不可逆操作

---

## 3. 排版

### 3.1 字号阶梯

无显式 token，按惯例使用：

| 用途 | px | 来源 |
|---|---|---|
| 页面 H2 标题 | 24-28 | 自定义 |
| 卡片 H3 | 16-18 | 自定义 |
| 表单 label | 13 | `client/src/index.css` `.form-label` |
| 正文 | 14 | 默认 |
| 辅助说明 / muted | 12 | 自定义 |
| 表头 / uppercase | 12 + `letter-spacing: 0.5px` | `.table th` |

### 3.2 字色

| Token | 用途 |
|---|---|
| `var(--text-primary)` | 标题、正文、链接 |
| `var(--text-secondary)` | 副标题、说明文字 |
| `var(--text-muted)` | 元信息（时间戳、ID、版权） |

---

## 4. 间距

无 spacing token；按 4px / 8px / 12px / 16px / 24px / 32px 阶梯使用，常见用法：

- 卡片 padding: 16px (紧凑) / 24px (标准)
- 元素之间间距: 8px / 12px / 16px / 24px
- 页面顶/底边距: 24px / 32px
- 模态内距: 16-24px

---

## 5. 圆角

| Token | 像素 | 用途 |
|---|---|---|
| `var(--radius-sm)` | 8px | 小按钮、tag、input |
| `var(--radius)` | 12px | 卡片、modal |
| `var(--radius-lg)` | 16px | 大卡（hero、empty state） |

---

## 6. 阴影

| Token | 用途 |
|---|---|
| `var(--shadow)` | 卡片悬浮、drawer |
| `var(--shadow-lg)` | modal、toast 弹出 |

不用 inset shadow / 多层 shadow 堆叠 —— Dark theme 上靠背景层级而不是阴影来分层。

---

## 7. 组件用法

### 7.1 按钮

```jsx
<button className="btn btn-primary">Save</button>     {/* 主操作，accent 色 */}
<button className="btn btn-secondary">Cancel</button> {/* 次操作，bg-card 色 */}
<button className="btn-icon" aria-label={t('common.close')} title={t('common.close')}>✕</button>
```

**规则：**
- 一屏最多 1 个 `btn-primary`
- icon 按钮**必须**带 `aria-label` 和 `title`（否则屏幕阅读器读不出来）—— 已批量整改，新增 icon 按钮不要破坏

### 7.2 卡片

```jsx
<div className="card">  {/* bg-card + border + radius */}
  <h3>Card title</h3>
  <p>Content</p>
</div>
```

### 7.3 表单

```jsx
<div className="form-group">
  <label className="form-label" htmlFor="name">Name</label>
  <input id="name" className="form-input" />
</div>
```

**规则：**
- 每个 input 必须有 `<label>` 关联（`htmlFor` + `id` 配对）—— 当前还有部分历史代码用 placeholder 替代 label，Sprint 2 task C5 整改中，新代码不要再添新债
- `placeholder` 只作辅助提示，不可作为唯一标识
- 错误信息放 input 下方，红色 `var(--danger)` 字 + 12px

### 7.4 状态徽章

```jsx
<span className="badge badge-green">approved</span>
<span className="badge badge-orange">pending</span>
<span className="badge badge-red">failed</span>
<span className="badge badge-purple">3 steps</span>
<span className="badge badge-gray">draft</span>
```

### 7.5 错误状态

API 失败时不要让用户看到空白页或永久 spinner：

```jsx
{loadError && data.length === 0 && (
  <ErrorCard error={loadError} onRetry={loadData} />
)}
```

`ErrorCard` 组件接受 `error`（Error / string）+ `onRetry`（函数）+ 可选 `title` / `body` / `compact`。

### 7.6 错误边界

App 顶层包了 `<ErrorBoundary>`，子组件抛错会显示重试 UI 而不是白屏。新增的 lazy-loaded 页面建议在 `<Suspense>` 外再包一层 `<ErrorBoundary>`，给页面级粒度的恢复。

---

## 8. 页面布局

### 8.1 主应用布局（已登录）

```
┌─────────────────────────────────────────────────────┐
│ Sidebar (240px)  │  Main wrapper                    │
│ - Logo           │  ┌─ GlobalHeader ──────────────┐ │
│ - Workspace      │  │ Campaign select | Lang switch│ │
│ - Nav (17 links) │  └──────────────────────────────┘ │
│ - User menu      │  Main content                    │
└─────────────────────────────────────────────────────┘
```

`client/src/App.jsx` 的 `<aside class="sidebar">` 是侧栏；nav 项每个挂 `aria-label` + `title`（已批量整改，不要破坏）。

### 8.2 公共布局（未登录）

无侧栏。`/login` 渲染 AuthPage，`/accept-invite?token=xxx` 渲染 AcceptInvitePage，`/` 渲染 LandingPage。

### 8.3 模态

- 遮罩点击关闭
- ESC 关闭（Browser 默认行为，注意 `e.stopPropagation()`）
- 标题栏带 ✕ 按钮（必须有 `aria-label={t('common.close')}`）
- 最大宽度 480-680px，超过用 drawer 而非 modal

### 8.4 Drawer

用于「次要操作但需要更多空间」的场景（如 ContactThreadDrawer 显示邮件历史）。从右侧滑出，宽度 400-560px。

---

## 9. 国际化（i18n）

### 9.1 字典结构

`client/src/i18n.jsx` 是单文件、两套字典（`en` + `zh`）。每个 key 形如 `nav.conductor` / `auth.sign_in` / `roi.title`。

### 9.2 规则

- **任何用户可见文字必须走 `t('key')`**，不允许硬编码英文/中文
- 新增 key 时**两个字典都要加**（漏一个会显示 key 名而不是文字）
- 占位用 `{{var}}` 语法：`t('campaigns.kols_total', { count: 4 })`
- 变量名使用 snake_case（与 i18n key 风格一致）

### 9.3 切换

`<LanguageSwitcher />` 组件挂在 GlobalHeader。语言存在 `localStorage`，跨会话持久。

---

## 10. 无障碍 (a11y)

### 10.1 必须项

1. **所有 icon 按钮带 `aria-label` + `title`**（屏幕阅读器 + tooltip）
2. **所有 form input 有关联 label**（`<label htmlFor>` 或 `aria-label`）
3. **导航链接带 `aria-label`**（侧栏 nav 当前已合规）
4. **错误信息可见且非颜色独立**（红色 + 文字 + ✕ 图标，不仅仅靠颜色辨识）
5. **键盘可达**：所有交互元素必须能 Tab 到 + Enter/Space 触发

### 10.2 ErrorBoundary 行为

子组件抛错时 ErrorBoundary 捕获，显示 fallback UI 包含「重新加载」+「重试」按钮。`role="alert"` 让屏幕阅读器立即朗读错误。

### 10.3 焦点管理

- Modal 打开时第一个交互元素自动聚焦（如 AcceptInvitePage 自动聚焦 name input）
- Modal 关闭时焦点返回到触发按钮（暂未实现，Sprint 2 C5 一起处理）

---

## 11. 动效

无动效 token；常用 CSS：

- `transition: all 0.15s` — 按钮 hover、tab 切换
- `animation: fadeIn 0.2s ease` — toast / modal 出现
- `animation: spin 1s linear infinite` — loading spinner

**规则：**
- 不用过度的弹簧 / bounce 动画 —— 专业感优先
- 长任务（>500ms）必须有 progress feedback，不能只是 button disabled

---

## 12. 数据可视化

`recharts` 库（已在 bundle）。

| 用途 | 组件 |
|---|---|
| 漏斗 | RoiDashboard 用 BarChart 横向 |
| 时间序列 | LineChart（邮件发送/送达/打开按日） |
| 状态分布 | PieChart 或 BarChart |

**调色板：**
```js
const FUNNEL_COLORS = ['#6c5ce7', '#74b9ff', '#54a0ff', '#a29bfe', '#00d2a0', '#fdcb6e', '#ff9ff3', '#00b894'];
```

**规则：**
- 不用 3D / 阴影图表
- 标签必须有单位（"%"、"K"、"M"）
- 0 值时显示 "-" 而不是 0，避免误读

---

## 13. 反模式 / 不要做的事

1. ❌ 在 AppContent 之外的 ErrorBoundary 抛错（会导致整个 React tree 重建）
2. ❌ 在 button 用 `<a href>` 替代（语义错；屏幕阅读器会念成 link）
3. ❌ 在 form 提交时不显示 loading / disabled 状态（用户会重复点击）
4. ❌ 把多个 unrelated 信息塞进同一个 Toast（Toast 单条信息原则）
5. ❌ 用 `console.log` 调试遗留在生产代码（用 `logger.debug` from `server/logger.js`）
6. ❌ 在 React state 里保存非 serializable 对象（如 Date 实例）—— 渲染会出问题

---

## 14. 后续规划

详见 [`ROADMAP_2026-Q2.md`](./ROADMAP_2026-Q2.md)：
- Sprint 1 task C5 — `<FormField>` 组件抽取 + 全表单改造（WCAG 2.1 Level A）
- Sprint 2 task C2 — Vitest 组件单测覆盖核心组件
- 长期 — 引入 Storybook 或类似工具固化组件契约（暂未排期）
