# InfluenceX 用户操作手册

> **写给谁看**：第一次使用 InfluenceX 的小白用户、被邀请加入工作区的新成员、想了解平台能做什么的潜在用户。
> **不需要任何技术背景。** 只要会用浏览器即可。
> **建议第一次阅读时间**：20 分钟过一遍 + 30 分钟跟着做完一次端到端流程。

---

## 第一部分：InfluenceX 是什么

### 一句话介绍

> **"你睡觉的时候，AI 帮你跑完整个内容营销链条。"**

InfluenceX 是一个**邀请制的 AI 营销自动化平台**。它能帮品牌完成下面这条链路：

```
找到合适的 KOL  →  自动写邮件邀约合作  →  发送 + 监控回信
              ↓                                     ↓
        生成内容（图/文/语音/视频）  →  排期发布到社媒  →  追踪 ROI
```

整个流程由 **18 个 AI Agent**（智能体）协同完成。你只需要告诉它"目标"，它来想"怎么做"。

### 适合谁用

- **中小企业市场负责人** — 没有大型营销团队，想用 AI 替代 80% 的重复劳动
- **DTC / 电商品牌** — 大量做 KOL 合作 + 内容投放
- **Solo 创业者** — 一个人当一支队伍用
- **跨境品牌** — 需要中英双语 + 多平台联动

### 核心能力速览

| 模块 | 一句话作用 |
|---|---|
| **Conductor**（指挥官） | 你给目标，AI 拆解步骤，逐项执行 |
| **KOL Discovery** | 输入关键词 → 自动从 YouTube / TikTok / Instagram 挖到合适达人 |
| **Pipeline**（外联流水线） | 自动写邀约邮件 → 你审核 → 发出 → 跟回信 |
| **Content Studio** | AI 写帖子 / 生成图 / 生成配音 / 生成视频脚本 |
| **Calendar**（发布日历） | 拖拽式排期内容到各社媒平台 |
| **Inbox**（社区收件箱） | 邮件回复 + 评论 / 私信 集中处理 |
| **Analytics + ROI** | 实时流量、转化漏斗、活动 ROI 一图看完 |
| **Brand Voice** | 训练 AI 学你的品牌口吻 |
| **Translate** | 一键多语本地化 |
| **Ads Strategist** | AI 生成广告策略与文案 |

---

## 第二部分：怎么进来（注册 / 登录）

### 路径 A：你有「邀请码」

如果朋友 / 同事 / 销售给了你一串形如 **`INFLX-XXXXXXXX`** 的邀请码：

1. 打开 https://influencexes.com/
2. 点 **"Sign In"** 进入登录页
3. 在 Sign In 按钮下方点明显的次按钮 **「Sign up with invite code（使用邀请码注册）」**
4. 粘贴邀请码 → 点 **Continue（继续）**
5. 系统会显示「将以 XX 角色加入 XX 工作区」—— 确认无误后填：
   - **Name（姓名）**：你的真名或昵称
   - **Email（邮箱）**：日常使用的邮箱（一旦注册不可改）
   - **Password（密码）**：至少 6 个字符（右侧 👁 可显隐核对）
6. 点 **Create account（创建账户）** → 自动登录，直接进入工作区

> 也可以直接打开带邀请码的链接：`https://influencexes.com/#/signup?code=INFLX-XXXXXXXX`，省去步骤 2-4。

### 路径 B：你收到了「邀请邮件」

管理员可能直接通过邮箱给你发了一封邀请邮件（链接形如 `/#/accept-invite?token=...`）：

1. 在邮箱里点击链接
2. 页面会显示邀请详情（来自谁、加入哪个工作区、什么角色）
3. 设置 **Name（姓名）** + **Password（密码）**
4. 点 **Accept & create account（接受并创建账户）** → 自动登录

### 路径 C：直接登录（已有账户）

1. 打开 https://influencexes.com/
2. 点 **"Sign In"**
3. 输入 **邮箱 + 密码** → 登录
4. 或者点 **"Continue with Google"** 走 Google SSO

> **小贴士**：
> - 密码框右侧有 **👁 显隐切换**，可以确认你输入对了
> - 第一次登录如果**没有任何工作区**，系统会自动给你创建一份默认 workspace（用你的姓名命名，可在 Workspace Settings 里改）
> - 登录后落地页根据数据状态智能切换：
>   - 还没有 campaign → 跳到 **Conductor**（让 AI 帮你拆解第一个目标）
>   - 已有 campaign → 跳到 **Pipeline**（你日常的主战场）

### 常见登录问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 输入正确密码也登不上 | 5 次错密后被锁 15 分钟 | 等 15 分钟，或联系管理员重置 |
| "邀请码已过期" | 管理员设置了过期天数 | 让管理员重新生成 |
| "邀请码已用完" | 该邀请码到达使用上限 | 同上 |
| "邀请码已撤销" | 管理员手动撤销了 | 同上 |
| Google 登录跳到错误页 | OAuth 配置异常 | 用邮箱密码登录，或联系管理员 |

---

## 第三部分：界面导览

### 整体布局

登录后看到三个主要区域：

```
┌─────────────────────────────────────────────────────┐
│ ① 侧栏        │ ② 顶栏（工作区切换、活动选择、语言）  │
│  - Logo       │─────────────────────────────────────│
│  - 工作区切换  │                                     │
│  - 17 个功能  │                                     │
│  - 用户菜单   │ ③ 主内容区                            │
│              │                                     │
└─────────────────────────────────────────────────────┘
```

### 侧栏功能（按顺序）

| 图标 | 名称 | 一句话 |
|---|---|---|
| 🎯 | **Conductor** | 给 AI 一个目标，让它生成执行计划 |
| ✏ | **Content Studio** | 生成图文、视频脚本、配音 |
| 📅 | **Calendar** | 内容排期日历 |
| 🔗 | **Connections** | 连接邮箱、社交平台 |
| 📊 | **Analytics** | 流量与转化数据 |
| 💬 | **Community** | 邮件回复 + 评论收件箱 |
| 📢 | **Ads** | AI 广告策略 |
| 🌐 | **Translate** | 多语言本地化 |
| ⚙ | **Agents** | 18 个 AI 工作智能体 |
| ⚡ | **Pipeline** | KOL 外联流水线（核心功能） |
| 🎯 | **Campaigns** | 营销活动管理 |
| 📈 | **ROI** | 投资回报数据看板 |
| ✉ | **Contacts** | 联系人库 |
| 📊 | **Data** | 内容数据 + GA4 同步 |
| 👥 | **KOL Database** | 达人库（添加 / 浏览） |
| 👤 | **Users** | 工作区成员管理（管理员） |
| 🔑 | **Invite Codes** | 邀请码管理（仅平台管理员可见） |

### 顶栏

- **左侧**：当前 Campaign（活动）下拉切换 + 状态徽章
- **右侧**：语言切换（EN / ZH） + 工作区设置入口

### 工作区（Workspace）切换

侧栏顶部 Logo 下方点击你的工作区名 → 出现下拉：
- 已加入的所有工作区列表
- "+ New workspace"（创建新工作区）
- "⚙ Workspace settings"（当前工作区设置）

> **核心概念**：每个工作区是独立的数据沙盒。Workspace A 的活动 / KOL / 邮件 在 Workspace B 看不到。一个邮箱可以加入多个工作区。

### 用户菜单（左下角）

点击头像 → 下拉显示：
- 你的角色（Admin / Editor / Viewer）
- **Sign Out**（登出）

---

## 第四部分：第一次使用的推荐路径

下面是 **30 分钟新手上手流程**，按顺序做完你就摸清核心链路了。

### Step 1：连一个邮箱（用于发外联邮件）

1. 侧栏点 **Connections**
2. 选 **"+ Connect Gmail"**（推荐）或 **Custom SMTP**
3. Gmail：弹出 OAuth 授权页 → 选你的 Google 账户 → 授权完成
4. 回到 Connections 页，看到该邮箱卡片显示 ✓ Verified

> 没有连邮箱也能用，但发外联邮件时会用平台默认发件人（contact@market.hakko.ai），from 不是你的品牌邮箱。

### Step 2：建一个 Campaign（营销活动）

1. 侧栏点 **Campaigns**
2. 右上角 **"+ New Campaign"**
3. 填：
   - **Name**：如「春季新品推广」
   - **Description**：1-2 句话目标说明
   - （可选）**Budget**、**Start / End Date**
4. **Save** → 列表立即出现

### Step 3：找几个 KOL（达人发现）

**方式 1：手动加单个 KOL**
1. 侧栏点 **KOL Database**
2. 上方输入 KOL 主页 URL（如 `https://www.youtube.com/@channelname`）
3. 点 **Add** → 自动抓取粉丝数、平均播放、邮箱

**方式 2：批量发现（用 AI）**
1. 侧栏点 **Agents** → 找 **discovery** Agent
2. 输入：
   - 平台（YouTube / TikTok / Instagram）
   - 关键词（如 "fitness equipment review"）
   - 粉丝数下限（如 10k）
3. 跑 → 几分钟后获得 20-50 个候选 KOL，自动入库

**方式 3：让 Conductor 帮你做**
1. 侧栏点 **Conductor**
2. 输入「找 30 个测评游戏设备的 YouTube KOL，粉丝 5万-50万」
3. AI 拆解步骤 → 你点确认 → 自动跑 discovery + 入库

### Step 4：跑 Pipeline（外联流水线）

1. 侧栏点 **Pipeline**
2. 选 KOL（来自 KOL Database） → 选 Campaign → 点 **Start outreach**
3. 等几秒 —— Pipeline 自动经历 5 个阶段：
   - **scrape**（抓取）→ 拉取 KOL 公开信息
   - **write**（撰写）→ AI 用 LLM 起草外联邮件
   - **review**（审核）→ **你需要审核！** 在这里编辑邮件内容、改主题、加附件
   - **send**（发送）→ 你点 Approve 后入队发送
   - **monitor**（监控）→ 实时显示 delivered / opened / replied
4. 收到回信会自动出现在 **Community Inbox**

> 流水线**永远在 review 阶段等你审核**，不会未经允许直接发邮件给真实 KOL。

### Step 5：生成一篇内容

1. 侧栏点 **Content Studio**
2. 选格式（Twitter / LinkedIn / Blog / Email / Caption / YouTube Short / Image / Voice / Video）
3. 写 brief（如「写一篇关于 AI 替代 80% 营销劳动力的 LinkedIn 帖子，对小型创业者口吻，最后含 CTA 链接」）
4. （可选）选 **Brand Voice** 让 AI 模仿你的品牌口吻
5. 点 **Generate** → AI 输出
6. 不满意 → 改 brief 重生，或手动编辑文本
7. 满意 → **Save to library**（保存到内容库）

### Step 6：排期发布

1. 侧栏点 **Calendar**
2. 拖拽内容到日期格子 → 选平台 → 设时间
3. 到时间 AI 自动发布（前提：Connections 里已连对应平台 OAuth）

### Step 7：看效果

- **Analytics** — 流量、来源、转化
- **ROI** — 漏斗图：scrape → contact → sent → opened → replied → signed
- **Inbox** — 集中处理回信、评论、私信

---

## 第五部分：核心模块详解

### 5.1 Conductor（AI 指挥官）

**它是干嘛的**：你说目标，它说"怎么做"。然后你点确认，它执行。

**怎么用**：
1. 侧栏 → **Conductor**
2. **Preset goals**（预设目标）：点击卡片直接跑（如 "Launch Q2 outreach for 50 gaming KOLs"）
3. **Custom goal**（自定义目标）：自己写一段（如"为新品发布找 30 个美妆 KOL 并发邀约邮件"）
4. AI 用 SSE 流式输出 plan（计划），你能实时看到 step 1, 2, 3...
5. 每个 step 你可以：**Approve**（执行）/ **Edit**（修改）/ **Skip**（跳过）
6. **History**：所有跑过的 plan 都存档，可回看

**适合什么场景**：
- 不知道从哪开始
- 任务复杂、想让 AI 拆解
- 想验证想法是否合理（拆解后能看到所需资源 / 时间）

### 5.2 Pipeline（外联流水线）

**核心概念**：5 个 stage 的状态机，每个 KOL 都走过这 5 步。

| Stage | 谁触发 | 持续时间 | 你能做什么 |
|---|---|---|---|
| **scrape** | 系统自动 | 数秒-几十秒 | 等待 |
| **write** | 系统自动 | 数秒（LLM 调用） | 等待 |
| **review** | 等你审核 | 任意 | **改邮件 → Approve / Reject** |
| **send** | 你 Approve | 数秒 | 等待 worker |
| **monitor** | Webhook 触发 | 持续 | 看 status 变化 |

**关键操作**：
- **Edit email**：在 review 阶段点编辑按钮，改 subject / body
- **Apply template**：选已有模板套用（含 A/B 变体）
- **Approve**：发送出去（不可撤回）
- **Reject**：移到 review/draft 列，不发
- **Schedule**：定时发送（在 Calendar 模块）

### 5.3 Contacts（联系人 + 邮件管理）

**和 Pipeline 的关系**：Pipeline 跑到 write 阶段会自动创建一个 Contact。Contacts 页面可以**直接管理**所有邮件（不一定走 Pipeline）。

**功能**：
- 列表 / 筛选（status、campaign、最近活动）
- 单发 / 批量发 / 重试
- Hunter.io 自动找邮箱（手填域名也能找）
- 回信 thread（点击进 drawer 看历史邮件 + 写回复）
- 5 秒轮询自动更新状态（多 tab 自适应防 429）

### 5.4 Email Templates + A/B 测试

**怎么用**：
1. 在 Contacts 页或 Pipeline review 阶段点 **Templates**
2. 创建 template：name + subject + body（支持 `{{kol.name}}` 等变量）
3. 添加 **A/B variant**（变体 B、C）
4. 批量发邮件时勾选 **Split test** → 后端按比例发不同变体
5. 在 Stats 页看 open / click / reply 率
6. 数据足够时点 **Promote winner**（提升赢家） → winner 升为主模板

### 5.5 Content Studio（AI 内容生成）

**支持的格式**：Twitter / LinkedIn / Blog / Email / Caption / YouTube Short / Image / Voice / Video

**Brand Voice**：先在 Workspace Settings 里训练一个 Brand Voice（粘贴 5-10 段你的品牌历史文案），生成时勾选它，AI 会模仿你的口吻。

**Tips**：
- brief 写得越具体输出越好（用「目标受众 + 卖点 + 期望情绪」三段式）
- 不满意先改 brief 重生，再改局部
- "Save preset" 把好用的 brief 存为模板，下次一键应用

### 5.6 Inbox（统一收件箱）

**功能**：
- 来自所有 Connections（Gmail、Instagram、TikTok 评论、YouTube 评论）的消息汇总
- 标记 已读 / 完成 / 跟进
- 直接回复（走对应平台 API）
- 优先级排序（红：紧急客户 / 黄：未读 / 灰：已处理）

### 5.7 Calendar（发布日历）

**功能**：
- 月 / 周 / 日视图
- 拖拽内容到时间格 → 选平台 → 排期
- 到时自动发布（需要 Connections 里已连接平台 OAuth）
- 失败有红色标记 + Retry 按钮

### 5.8 Analytics + ROI

**Analytics**（分析）：
- 实时在线人数（GA4 接入）
- 历史流量 / 来源 / 转化
- 内容表现（按 piece 看 view、share、CTR）

**ROI**（投资回报）：
- 漏斗图：scrape → contact → sent → opened → replied → signed
- 按 campaign 切换数据
- 0 值显示 "—" 而非 0（避免误读）

### 5.9 Translate（多语言本地化）

输入一段文本 + 选目标语言（最多 8 种）→ AI 一键翻译。可保留 brand voice 与术语一致性。

### 5.10 Ads（广告策略）

输入产品 + 目标受众 + 预算 → AI 生成多平台（Meta / Google / TikTok）的广告策略 + 文案变体。**不会自动投放**，最终需要你去对应平台手动投。

### 5.11 Brand Voice（品牌声音）

在 **Workspace Settings → Brand Voices** 里：
1. 粘贴 5-10 段你过往的好文案
2. 给它命个名（如 "professional-tech" / "playful-DTC"）
3. AI 会生成 embedding 向量
4. 在 Content Studio 生成内容时选这个 voice，AI 会自动匹配最相关的历史片段做风格学习

---

## 第六部分：管理员专属功能

### 6.1 Users（成员管理）

只有有 `user.invite` 权限的角色（admin / editor）能看 Users 页。

**功能**：
- 查看 workspace 所有成员
- 邀请新成员（输入邮箱 → 系统判断邮箱是否已注册）：
  - 已注册 → 直接加为 member
  - 未注册 → 生成邀请 token + 链接，自动发邮件
- 修改成员角色（Admin / Editor / Viewer）
- 移除成员（不能移自己）

### 6.2 Invite Codes（邀请码 — 平台管理员专属）

**只有 `users.role = admin`（平台级管理员）** 能看到这个 nav 项。

**功能**：
- 生成可分享的邀请码（形如 `INFLX-XXXXXXXX`）
- 设置目标 workspace + 默认角色（admin / editor / viewer）
- 设置最大使用次数（1-1000）+ 有效期（1-365 天，留空表示永久）
- 添加备注（如 "Q2 partner batch"）
- **Copy code**（复制邀请码） / **Copy link**（复制带码的注册链接）
- **Revoke**（撤销）—— 撤销后该码不可再用

**和 per-email 邀请的区别**：
| 特性 | per-email 邀请 | invite code |
|---|---|---|
| 入口 | Workspace Settings → Invite Member | Invite Codes 页 |
| 绑定邮箱 | 是（only that email can use） | 否（任何人持码可注册） |
| 单次还是多次 | 单次 | 1-1000 次（你设置） |
| 适合谁 | 知道对方邮箱、定向邀请 | 批量招募 / 不知道具体邮箱 |
| 谁能创建 | workspace admin | platform admin (`users.role=admin`) |

**典型工作流**：
1. 「我要把这个码发给 50 个内容合作伙伴」→ 创建一个 max_uses=50, 有效期=30 天 的码
2. 「合作结束了」→ 撤销
3. 「内部新员工招募」→ 创建一个 admin 角色的码，max_uses=10
4. 「过期管理」→ 列表筛选，看哪些 active / expired / exhausted

**生成后立即分享**：
- 创建成功后，页面顶部会高亮一个 **「Invite code ready to share / 邀请码已生成，可立即分享」** 面板
- 三个一键按钮：
  - **Copy code（复制邀请码）** — 仅复制 `INFLX-XXXXXXXX`
  - **Copy link（复制注册链接）** — 复制 `https://.../#/signup?code=...`
  - **Copy share message（复制分享文案）** — 复制中英版完整邀请文案，直接粘贴到邮件 / 微信 / Slack 即可

### 6.3 Workspace Settings

**Members tab**：
- 邀请新成员（per-email 流程）
- 修改 role
- 移除成员

**Brand Voices tab**：
- 创建 / 删除 brand voice
- 查看 embedding 状态

**Workspace tab**：
- 改名、改描述
- 删除工作区（不可逆，二次确认）

---

## 第七部分：常见问题（FAQ）

### Q1：我是 small company，没有 LLM API key，能用吗？

**能**。InfluenceX 部署版本（influencexes.com）已配置共享 LLM key，开箱即用。如果自托管才需要自己的 key。

### Q2：Pipeline 跑到一半卡住了怎么办？

1. 看 Pipeline 列表里该 job 的 stage 字段
2. 如果一直在 `scrape` / `write` —— 可能 LLM 临时抽风，几分钟后会自动重试
3. 如果一直在 `review` —— 那是**等你审核**，去点 Approve 或 Reject
4. 如果显示 `failed` —— 看 error message，常见是邮箱 bounce / 模板渲染失败 → Edit & retry

### Q3：邮件被反垃圾标记了怎么办？

- 别用 generic public 邮箱（如 personal@gmail.com）做大量外联
- 在 Connections 里连**自有域名 + DKIM/SPF 验证通过**的发件人
- 单个发件人**每天不要超过 30 封新外联**
- 内容避免过多链接、附件、关键词触发器（如 "free", "guarantee"）

### Q4：怎么取消已排期的发布？

Calendar → 点该日期格子 → 点该 publish item → **Cancel**（或 Reschedule）。

### Q5：怎么导出数据？

- KOL：Campaign 页 → **Export KOLs CSV**
- Contacts：Campaign 页 → **Export Contacts CSV**
- KOL Database 整体：KOL Database 页 → **Export**
- 内容数据：Data 页 → **Export content**

### Q6：我不是工程师，能私有部署吗？

InfluenceX 是开源（MIT）的，技术伙伴可以自部署到 GCP Cloud Run。但如果你不是工程师，**直接用 https://influencexes.com/** 是最简单的（也是免费的）。

### Q7：发邮件用的是什么邮箱？

- 默认：`contact@market.hakko.ai`（平台共享发件人，回信会转给 `market@hakko.ai`）
- 如果你在 Connections 里连了自己的 Gmail / SMTP → 用你自己的邮箱发
- A/B test 模板可针对不同变体用不同发件人

### Q8：Workspace 之间数据会串吗？

**不会**。每个 API 调用都强制带 `workspace_id`，数据库层面强隔离。你切换工作区时所有页面都会重新加载属于该工作区的数据。

### Q9：邀请码是终身有效吗？

**不是**。看你创建时的设置：
- 没设过期 → 永久有效（直到达到 max_uses 或被 revoke）
- 设了 X 天 → X 天后自动失效

### Q10：我能给 KOL 发中文邮件吗？

**能**。在 Pipeline 的 review 阶段，AI 会根据 KOL 资料判断使用语言，但你可以**手动改成任意语言**。也可以用 Translate 模块批量翻译模板。

---

## 第八部分：进阶玩法

### 玩法 1：把 Conductor 当总指挥

不要在每个模块单独操作。养成习惯：先到 Conductor 写目标，让 AI 拆解。这样：
- 一个目标可能拆成「discovery → write template → batch send → schedule follow-up」4 个 step
- AI 会自动配合 18 个 agent 一起跑
- 你只需在关键 step 点 Approve

### 玩法 2：用 A/B test 优化邮件模板

1. 第一次外联用一个模板 A
2. 加一个变体 B（改主题或开头）
3. 批量发 200 封 → 系统按比例分流
4. 等 7 天 → 看 stats（哪个 open 率高 / reply 率高）
5. 点 **Promote winner** → 把赢家升为默认
6. 重复，永远在优化

### 玩法 3：Brand Voice + 多语言

1. 训练一个 Brand Voice（如 "Hakko 中文官腔"）
2. 用 Content Studio + Brand Voice 生成中文内容
3. 用 Translate 翻成英文/日文/韩文（保留 brand voice 一致）
4. 一次产出 4 种语言版本

### 玩法 4：用 Agents 跑研究 + 内容流水线

每周一固定流程：
1. **research agent** → 输出本周行业关键词 + 竞品动态
2. **content-text agent** → 基于 research 生成 5 篇博客大纲
3. 你审核 → 留 3 篇 → **content-visual agent** 出封面图
4. 排到 Calendar 周二 / 四 / 六发布
5. 全程 1 小时人工，4 小时 AI 跑

### 玩法 5：用 Inbox 一日清

- 每天上班第一件事：Inbox → 按优先级排
- 红色（紧急）→ 立即回
- 黄色（未读）→ 半小时内分类（要回 / 待跟进 / 自动模板）
- 灰色（已处理）→ 偶尔回顾

---

## 第九部分：键盘 / 操作技巧

| 快捷键 / 技巧 | 效果 |
|---|---|
| **Tab** | 在表单 / 列表中切换焦点 |
| **Enter**（输入框） | 提交表单 |
| **ESC** | 关闭模态框 / 抽屉 |
| **点遮罩** | 关闭模态框 |
| 拖拽（Calendar） | 排期内容 |
| 双击（KOL 行） | 进入详情 |
| 点击邮箱图标 | 直接打开邮件 thread |
| 工作区切换 → ESC | 取消选择 |

---

## 第十部分：寻求帮助

| 场景 | 找谁 |
|---|---|
| 平台 bug / 报错 | 联系给你邀请的管理员 |
| 想加新功能 | https://github.com/oratis/influencex/issues |
| 想私有部署 | 看 GitHub README |
| 紧急生产问题 | 看 [docs/USER_GUIDE.md](./USER_GUIDE.md) 的 Troubleshooting 章节 |

---

## 附：术语表

| 术语 | 含义 |
|---|---|
| **Workspace（工作区）** | 数据沙盒。一个公司 = 一个 workspace（一般情况） |
| **Campaign（活动）** | 营销活动，是 KOL / contact / 内容的容器 |
| **KOL** | Key Opinion Leader，达人 / 网红 / 创作者 |
| **Contact（联系人）** | 一个 KOL × 一个 Campaign 的关系，承载邮件状态 |
| **Pipeline（流水线）** | 外联流程的状态机（scrape → write → review → send → monitor） |
| **Conductor（指挥官）** | AI 目标拆解 + 执行编排器 |
| **Agent（智能体）** | 18 个专门职能的 AI 子模块 |
| **Brand Voice** | 品牌口吻样本 + 向量索引 |
| **Invite Code（邀请码）** | 通用注册码，平台管理员生成 |
| **Invitation（邀请）** | 绑定邮箱的邀请链接 |
| **A/B test** | 同时跑多个邮件 / 内容变体，统计最优 |
| **ROI** | 投资回报，从 KOL 触达到签约的全链路漏斗 |
| **GA4** | Google Analytics 4，流量数据源 |
| **Resend** | 默认邮件发送服务商 |
| **Hunter.io** | 邮箱查找服务（输入域名 → 找潜在邮箱） |
| **pgvector** | Postgres 向量索引（用于 Brand Voice 相似检索） |

---

**祝你用得开心。**
**有任何问题，先回到 [Conductor](#5-1-conductor-ai-指挥官) 问 AI —— 70% 的「不知道怎么做」它都能直接帮你拆出步骤。**

---

*Last updated: 2026-04-27 (commit 4619956 + invite-code feature)*
