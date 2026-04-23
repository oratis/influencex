# InfluenceX 产品指南

> 面向用户的完整使用手册。以"我是新登录的运营/创业者，我要从零用这套系统做内容 + 投 KOL + 跑分析"的视角展开。

---

## 目录

1. [平台总览](#1-平台总览)
2. [快速开始：10 分钟跑通第一条内容](#2-快速开始10-分钟跑通第一条内容)
3. [导航地图：每个入口对应什么](#3-导航地图每个入口对应什么)
4. [内容创作（Content Studio + 各类 Agent）](#4-内容创作content-studio--各类-agent)
5. [发布与日程（Connections + Calendar）](#5-发布与日程connections--calendar)
6. [KOL 发现与合作（Campaigns · Pipeline · KOL Database · Contacts）](#6-kol-发现与合作campaigns--pipeline--kol-database--contacts)
7. [社群管理（Community Inbox）](#7-社群管理community-inbox)
8. [广告计划（Ads）](#8-广告计划ads)
9. [翻译（Translate）](#9-翻译translate)
10. [分析（Analytics + ROI）](#10-分析analytics--roi)
11. [Conductor：用一句话跑一条流水线](#11-conductor用一句话跑一条流水线)
12. [账户、工作区与团队](#12-账户工作区与团队)
13. [订阅与账单（Billing）](#13-订阅与账单billing)
14. [Agent 百科（完整清单）](#14-agent-百科完整清单)
15. [成本、限额与常见问题](#15-成本限额与常见问题)

---

## 1. 平台总览

InfluenceX 是一套「AI 内容生产 + KOL 投放 + 社群管理」一体化平台，核心理念：

- **所有"会花钱调用 AI"的操作都被封装成 Agent**（策略、选题、文案、配图、视频脚本、SEO、竞品、翻译、评论洞察、分析报告……）。每个 Agent 都有明确的输入/输出和成本预估。
- **多租户工作区**。每个工作区独立管理自己的 Campaign、KOL、授权账号、账单。支持管理员/编辑/浏览者三种角色。
- **原生 OAuth 一键发布** + **Intent URL 兜底**。已打通 OAuth 的平台（Twitter/X, LinkedIn, YouTube, TikTok, Instagram, Facebook, Threads, Pinterest, Reddit, Medium, Ghost, WordPress）可直接 API 发帖；其余平台会生成预填好的一键撰写链接。
- **Conductor 计划中枢**。可以用自然语言描述一个整体目标，系统自动拆成多 Agent 的 DAG 计划，按依赖并发执行。

登录后默认落地到 **Pipeline 页**（`/pipeline`），可以从左侧导航进入其他模块。

---

## 2. 快速开始：10 分钟跑通第一条内容

> 目标：注册账号 → 生成一条 Twitter 文案 → 定时发布。

1. **注册或登录**
   - 访问首页，点右上角 **Sign up**，支持邮箱/密码或 **Google 一键登录**。
   - 首次登录后会自动创建一个默认工作区。

2. **连接你的发布账号（可选，但推荐）**
   - 左侧导航 → **Connections**。
   - 在 Twitter/X 卡片上点 **Connect**，弹出的 OAuth 授权窗口里完成授权即可。未连接也能用，只是只能拿到 Intent URL（一键打开官方撰写框），而不能"直接发"。

3. **去 Content Studio 写一条**
   - 左侧导航 → **Content Studio**。
   - 顶部选 **格式**：Twitter。
   - 在 **Brief** 里用一句话描述你想说什么，比如："今天的早咖啡冷知识：为什么咖啡因比你想的更晚到达大脑？"
   - 右上角可选 **Quality tier**：`fast`（Haiku，约 10¢）或 `quality`（Sonnet，约 25¢）。
   - 点 **Generate**。约 5–10 秒后右侧会出现带 hook、正文、hashtags、CTA 的草稿。

4. **定时或立刻发布**
   - 对草稿满意后，点 **Schedule**。
   - 选 **发布平台**（已连接的会显示 "Direct"，未连接的会显示 "Intent"）。
   - 选 **时间**。保存后，系统每 60 秒会扫一次到期任务，自动调用 Publisher Agent 发帖。
   - 去 **Calendar** 页即可看到这条定时帖，按状态（pending/running/complete/error）用颜色区分。

到这一步你已经跑通了「生成 → 发布 → 调度」的主链路。下面的章节是按模块深入。

---

## 3. 导航地图：每个入口对应什么

左侧导航从上到下（默认顺序）：

| 入口 | 路径 | 一句话描述 |
|---|---|---|
| Conductor | `/conductor` | 用自然语言描述目标，自动生成并执行多 Agent 计划 |
| Content Studio | `/studio` | 一站式内容创作（文案/图/视频/语音） |
| Calendar | `/calendar` | 月视图查看和编辑定时发布 |
| Connections | `/connections` | 管理各平台授权/API Key |
| Billing | `/billing` | 订阅套餐、账单、Stripe 客户门户 |
| Analytics | `/analytics` | 工作区级数据看板 |
| Community | `/inbox` | 社媒 @提及/评论 聚合、自动分类、回复草稿 |
| Ads | `/ads` | 广告投放计划（Meta/Google/TikTok） |
| Translate | `/translate` | 内容本地化到 16 种语言 |
| Agents | `/agents` | 所有 Agent 的说明与手动单次调用入口 |
| Pipeline | `/pipeline` | 抓取/写信/审核 等后台任务进度；内嵌 Discovery |
| Campaigns | `/campaigns` | KOL 投放活动的创建与管理 |
| ROI | `/roi` | 历史投放 ROI 看板 |
| Contacts | `/contacts` | KOL 外联全流程（签约/交付/付款） |
| Data | `/data` | 数据与报表模块 |
| KOL Database | `/kol-database` | 全局 KOL 数据库（跨 Campaign 可复用） |
| Users | `/users` | （管理员）平台用户与角色管理 |

**全局头部** 还有：
- **Campaign 选择器**：切换当前"活动"上下文，会影响 Contacts、KOL Database、Pipeline 等页面显示的数据。
- **Language Switcher**：中英双语界面切换。
- **Workspace Switcher**（左上角）：切换工作区。
- **用户菜单**（左下角）：显示当前角色，登出。

---

## 4. 内容创作（Content Studio + 各类 Agent）

### 4.1 Content Studio 的主体流程

进入 `/studio`，页面分左右两栏：

**左栏（输入）**：
- **Format**：twitter / linkedin / blog / email / caption / youtube-short / image。
- **Brief**：自由输入想表达的意思。越具体越好（含目标受众、关键信息点、希望的情绪/语气）。
- **Preset 下拉**：点击可载入之前保存过的提示词预设（比如"品牌年度活动文案模板""周五冷知识系列"）。
- **Quality tier**（仅文本）：`fast` 用 Haiku/Gemini Flash，约 10¢；`quality` 用 Sonnet，约 25¢。
- **Save as preset**：把当前 brief 存为可复用模板。

**右栏（输出）**：
- 流式渲染，可以看到 Agent 的推理过程和最终结果。
- 文本格式会拆分出 **Hook**、**Body**、**Hashtags**、**CTA**、**Word Count**、**Reasoning**。
- 图片格式会显示生成的图 + 用到的增强提示词。

### 4.2 各种格式详解

| 格式 | Agent | 典型用途 | 成本 |
|---|---|---|---|
| twitter / linkedin / blog / email / caption / youtube-short | `content-text` | 纯文本内容生产 | 10¢（fast）/ 25¢（quality） |
| image | `content-visual` | 配图、朋友圈图、博客头图 | 10–20¢（含 Claude 增强 prompt + 字节跳动豆包图像 API） |
| video | `content-video`（需从 Agents 页直接调用） | 短视频分镜 + 画外音脚本 | ~40¢（脚本 + 可选 ElevenLabs 配音） |
| voice | `content-voice`（从 Agents 页） | 纯语音合成 | 3–15¢ |

### 4.3 保存 Preset 最佳实践

Preset 是你和团队的"模板库"。建议把以下几类存为 preset：
- **内容系列模板**（例："周五冷知识系列"、"产品功能介绍"）
- **品牌声音约束**（例："始终包含#WellnessMonday，语气轻松不浮夸"）
- **活动专用**（例："618大促预热 / 正式期 / 返场"三个变体）

每个 preset 在 Analytics 里都有使用次数与成功率统计，可以对比哪些模板效果最好。

---

## 5. 发布与日程（Connections + Calendar）

### 5.1 Connections：先把发帖账号接进来

路径：`/connections`。

**支持直接 API 发帖（OAuth）的平台**：
- Twitter / X、LinkedIn、Instagram（Business 账号）、YouTube、TikTok、Facebook、Threads、Pinterest、Reddit

**API Key 接入**（需要粘贴 API Key 或 Token）：
- Medium、Ghost、WordPress

**只支持 Intent URL（生成一键发帖链接，不直接发）**：
- Bluesky、Weibo 等

**操作**：
1. 点平台卡片上的 **Connect**。
2. OAuth 平台会弹出授权窗口，授权完成后自动回调。
3. API Key 平台会弹出输入框，粘贴 Token/Key + 账号标识。
4. 连接成功后显示 "Connected" 状态和账号名。
5. 点 **Disconnect** 可解除授权（会吊销 token，需要重新授权才能再用）。

### 5.2 Calendar：月视图看所有定时任务

路径：`/calendar`。

- 月历网格展示所有 `scheduled_publishes` 表里的任务。
- **状态颜色**：橙=pending、蓝=running、绿=complete、红=error、灰=cancelled。
- 点某条任务会打开详情抽屉，展示内容快照、目标平台、模式（intent/direct）、错误信息（若有）。
- 失败重试：如果是瞬时错误（429、5xx、网络超时），系统会按 2 分钟 → 10 分钟 → 30 分钟 → 2 小时的退避重试，最多 3 次（可在数据库里配置 `max_attempts`）。输入错误（如缺图、subreddit 不存在）会立刻标为 error 不重试。

### 5.3 立即发 vs 定时发

从 Content Studio 生成内容后：
- **Schedule**：选未来时间 + 目标平台 → 系统会在到期时自动调用 Publisher Agent。
- **Publish now**：立刻执行。对 OAuth 已连接平台，会真的发帖；对未连接的会返回 Intent URL 供你手动点击。

---

## 6. KOL 发现与合作（Campaigns · Pipeline · KOL Database · Contacts）

这是一个完整四步流水线：创建活动 → 发现 KOL → 写外联 → 跟进交付。

### 6.1 Campaigns：第一步——创建一个活动

路径：`/campaigns`。

点 **+ New Campaign**，填：
- **Name**：如"618 美妆季 · 海外 KOL"。
- **Platforms**：TikTok / YouTube / Instagram / Twitch / X（多选）。
- **Daily KOL target**：每天要收集多少 KOL。
- **Budget**：本次活动预算。
- **Filter criteria**：最低粉丝、最低互动率、分类标签等。

创建后点进去可以看这个活动下的 KOL 收集进度、已审批数、预算使用。

> **Campaign 上下文**：活动创建后，全局头部的 Campaign 选择器会多一项。切换后，Contacts、Pipeline、KOL Database 的默认视图都会 scope 到这个活动。

### 6.2 Pipeline：发现与后台任务

路径：`/pipeline`，分两个 Tab：

**Pipeline Tab**：
- 看所有正在跑的后台任务：抓取 KOL 资料、生成外联邮件、审核草稿、发送追踪等。每个任务有进度条和状态。

**Discovery Tab**：
- 输入 YouTube 关键词（例："vegan skincare review"）。
- 设定订阅数区间（例：10k–200k）。
- 点 **Run Discovery**。系统会调 YouTube API（每个关键词消耗 101 配额单位），返回按相关度排序的频道列表，写入当前活动的 KOL 池。

### 6.3 KOL Database：全局 KOL 库

路径：`/kol-database`。

- 跨 Campaign 的全局 KOL 数据库。
- 按平台、姓名、互动率、粉丝区间搜索。
- 每条记录显示抓取状态（scraping / done / error）、AI 评分、简介链接。
- **Import from Campaign**：把某个活动里筛选过的 KOL 批量导入全局库，以便后续活动复用。
- **Export CSV**：一键下载完整数据。

### 6.4 Contacts：外联与交付跟踪

路径：`/contacts`。

展示该活动下每个 KOL 的合作漏斗：
Scrape → Write → Review → Send → Monitor → Done

每个 KOL 行会显示：
- **Contract**：签约状态（pending / signed）。
- **Content**：内容交付（submitted / approved / published）。
- **Payment**：打款（pending / paid）。

**典型操作**：
1. 从 Campaign 里审批 KOL → 自动进入 Contacts 列表。
2. 点 **Generate Drafts**，后台调用 `kol-outreach` Agent，批量生成模板化外联邮件（v1 版本是模板驱动，成本 $0）。
3. 人工进入每个草稿逐条审核/润色。
4. 审批后发出（需要先在 Connections 配好发信渠道）。

> 当前版本 **不会自动发邮件**——所有外联都需要你手动确认，防止误发伤品牌。

---

## 7. 社群管理（Community Inbox）

路径：`/inbox`。

**拉取**：
- 点 **Fetch new**，调用 `community` Agent 的 fetch action，拉取最近的 X（Twitter）@提及和评论到 `inbox_messages`。
- LinkedIn / Instagram / TikTok 的渠道已经脚手架但 v1 尚未接通。

**分类（triage）**：
- 点 **Classify**，Agent 会对未分类消息打 sentiment（positive/neutral/negative）和 priority（high/normal/low）标签。

**回复草稿**：
- 在某条消息上点 **Draft reply**，Agent 会结合品牌声音生成一版回复草稿。
- 草稿保存在该消息记录下，**不会自动发出**，等你人工审核修改后再手动回复到原平台。

**筛选**：左上角 Tabs 可按 open / replied / archived / 按平台筛选。

---

## 8. 广告计划（Ads）

路径：`/ads`。

这是一个**离线广告计划助手**，不会真的下广告。填表后输出一份结构化投放计划，你可以复制到 Meta Ads Manager / Google Ads / TikTok Ads Manager 里手工执行。

**填写**：
- 品牌名 & 简介
- 预算（总额）
- 时长（天数）
- 投放目标（awareness / traffic / conversion / leads / retention 等）
- 平台（Meta / Google / TikTok 多选）

**输出**：
- 每个平台的广告系列结构（campaign > ad set > ad）
- 创意变体（文案 + 画面方向）
- 受众定向（年龄、兴趣、地域、自定义受众建议）
- 预算分配建议
- UTM 参数模板

**未来方向（未实装）**：真实 Meta/Google/TikTok Ads API 对接见 Roadmap。

---

## 9. 翻译（Translate）

路径：`/translate`。

批量内容本地化工具。一次调用可翻译到多个语言。

**左栏（输入）**：
- **Title**（可选，仅元信息）
- **Source content**：原文。
- **Source language**：自动检测或手动指定。
- **Format**：tweet / post / blog / email / caption / ad（不同格式有不同长度与语气策略）。
- **Tone words**：可以指定额外的语气关键词（如 "playful, casual"）。
- **Preserve terms**：不翻译的术语白名单（品牌名、产品名、SKU）。
- **Target languages**：从 16 个预设中多选（es / fr / de / pt-BR / ja / ko / zh-CN / zh-TW / ar / hi / id / it / nl / pl / tr / ru），或手动输入符合 BCP-47 的语言码（如 `vi`、`th`、`sv-SE`）。

**右栏（输出）**：
- 每种语言一张卡片，显示翻译后的文本、字符数（对比该格式的上限）、推荐 hashtags、文化适配备注（例如"日语版略去了感叹号以避免显得急迫"）。
- 每张卡右上角有 **Copy** 按钮。

**成本**：约 40–60¢ 一次调用，批量翻译比多次单语言调用省钱。

---

## 10. 分析（Analytics + ROI）

### 10.1 Analytics 工作区看板

路径：`/analytics`。

展示本工作区的关键指标：

- **Spend 汇总**：终身总花费、今天花费。
- **Agent 调用**：总次数、Token 消耗。
- **Agent 性能表**：每个 Agent 的 runs、成功率、平均耗时、平均成本、p95 耗时。
- **Platform 统计**：各发布平台的成功率 / 失败率。
- **Preset 使用**：哪些模板被用得最多，平均产出质量如何。
- **Content type 效果**：按格式分布的成功率。

### 10.2 ROI Dashboard

路径：`/roi`。

（懒加载）展示历史投放活动的 ROI 数据：点击量、转化、归因（需要在 Ads + Analytics 都接通的前提下才有完整数据）。

### 10.3 用 Analytics Agent 生成周报

从 **Agents** 页（`/agents`）可以手动触发 `analytics` Agent：
- 输入：metrics 对象 + window（7d / 30d 等）+ 目标
- 输出：
  - **Headline**：一句话总结
  - **Insights**：具体洞察（带分类：platform / content / cost / pipeline / audience），每条附置信度和指标变化
  - **Anomalies**：峰值/骤降
  - **Recommendations**：按优先级排序的下一步动作（带建议 Agent）
  - **Data gaps**：缺了什么数据建议补

成本约 25¢。

---

## 11. Conductor：用一句话跑一条流水线

路径：`/conductor`。

**使用场景**：你不想一个个去挨个 Agent 调用，而是说"我想做一次新品上市预热，给我准备品牌策略 → 3 条文案（Twitter、LinkedIn、Blog） → 配图 → 翻译成日语韩语 → 排期到下周"。

**操作**：
1. 在文本框里描述你的整体目标（越具体越好）。
2. 点 **Plan**。系统调用 Claude 生成一个 DAG 计划，显示：
   - 每个节点用哪个 Agent
   - 输入是什么（可能依赖前一步的输出）
   - 预估成本
   - 总成本合计
3. 审阅计划，如果 OK，点 **Approve & Run**。
4. 系统按依赖拓扑并发执行（无依赖的节点并发跑）。实时显示每个节点的状态。
5. 全部完成后，结果会分别写入对应的表（content_pieces、scheduled_publishes 等），就像你手动跑一样。

**为什么用 Conductor**：复杂流水线一次性预估总花费，避免漏步骤，也能并发显著缩短等待时间。

---

## 12. 账户、工作区与团队

### 12.1 登录方式

- **邮箱/密码**：15 分钟内最多 5 次失败尝试（防爆破）。
- **Google 一键登录**：登录与注册都支持。
- **会话有效期 7 天**，过期后自动重新登录。

### 12.2 工作区（Workspace）

- 多租户隔离：每个工作区的 Campaign、KOL、连接、账单完全独立。
- 左上角 **Workspace Switcher** 切换。
- 默认注册会创建一个个人工作区。

### 12.3 工作区成员与角色

路径：`/workspace/settings`。

- 查看当前工作区成员和角色。
- **Invite member**：输入邮箱 + 选角色，发送邀请。
- **角色**：
  - **Admin**：完整权限（可邀请、改配置、看账单）
  - **Editor**：可创建/修改内容、运行 Agent、发布
  - **Viewer**：只读
- 点成员可改角色或移除。

### 12.4 全局用户管理（仅 Admin）

路径：`/users`。

- 跨工作区的用户列表。
- 邀请新用户（附临时密码）。
- 更改用户角色或删除。

---

## 13. 订阅与账单（Billing）

路径：`/billing`。

### 套餐对比

| 套餐 | 月费 | Agent 调用 | 工作区 | 备注 |
|---|---|---|---|---|
| Free | $0 | 100 runs/月，限 3 个 Agent | 1 | 适合试用 |
| Starter | $29 | 2,000 runs/月，全部 Agent | 3 | 适合个人/自由职业者 |
| Pro | $99 | 10,000 runs/月，解锁 Claude Sonnet 高质量层 | 10 | 适合小团队 |
| Business | $299 | 不限 runs，不限工作区，含 SerpAPI 真实搜索 | ∞ | 适合代理/中型公司 |

### 升级/降级

- 点 **Upgrade**，跳转 Stripe Checkout 完成支付。
- **Manage billing**：打开 Stripe Customer Portal 管理支付方式、查看历史发票、取消订阅。
- 变更会在下个计费周期生效。

### 配额用完怎么办？

- 临时超额会阻止新的 Agent 调用，现有定时任务不受影响。
- 升级套餐立刻恢复。

---

## 14. Agent 百科（完整清单）

所有 Agent 都可以在 `/agents` 页单次手动调用（查看每个的输入输出结构）。也可以被 Conductor 计划调度。

### 策略与研究
| Agent ID | 作用 | 典型输入 | 输出 | 成本 |
|---|---|---|---|---|
| `strategy` | 品牌策略 | 品牌描述 + 竞品 | ICP、品牌声音、内容支柱、发布节奏 | ~22¢ |
| `research` | 选题研究 | 话题关键词 | 趋势角度、关键词+意图、竞品速写、3–5 条选题简报 | ~28¢ |
| `competitor-monitor` | 竞品监控 | 竞品名/URL 列表 | 定位、定价信号、强弱项、最新动向、差异化角度 | 不定 |
| `seo` | SEO Brief | 话题或 URL | 主关键词 + 长尾词、大纲、内链建议、外链切入角度 | ~20¢ |
| `review-miner` | 评论洞察 | 产品名或评论原文 | 好评点、痛点、功能请求、可引用证言、情绪总分 | ~15¢ |

### 内容生产
| Agent ID | 作用 | 输出 | 成本 |
|---|---|---|---|
| `content-text` | 文案（tw/li/blog/email/caption/yt-short） | Hook + Body + Hashtags + CTA + Reasoning | 10¢（fast）/ 25¢（quality） |
| `content-visual` | 配图生成 | 图片 URL + 增强后的 prompt | 10–20¢ |
| `content-video` | 短视频脚本 | Hook（≤5s）+ 4–8 个镜头 + CTA，可选配音 | ~40¢ |
| `content-voice` | 语音合成 | MP3（Data URL） | 3–15¢ |

### 发布与分发
| Agent ID | 作用 | 模式 | 说明 |
|---|---|---|---|
| `publisher` | 多平台发布 | intent / direct | intent 返回 1 点击发帖 URL；direct 用 OAuth 直接发 | $0 |
| `translate` | 批量翻译 | — | 一次调用多语言，保留品牌语调与术语 | 40–60¢ |

### KOL 与外联
| Agent ID | 作用 | 输入 | 输出 | 成本 |
|---|---|---|---|---|
| `discovery` | YouTube 创作者发现 | 关键词 + 订阅区间 | 频道列表按相关度排序 | 101 YouTube 配额单位/关键词 |
| `kol-outreach` | 外联邮件草稿 | 活动 + 筛选条件 | 模板化草稿写入 contacts 表 | $0（v1 模板） |

### 社群与分析
| Agent ID | 作用 | action | 说明 |
|---|---|---|---|
| `community` | 社群三件套 | fetch / classify / draft | 拉取 @、分类打标、起草回复。不自动发。 | ~5¢/次 |
| `analytics` | 分析报告 | — | 产出 headline + insights + anomalies + recommendations + data gaps | ~25¢ |

---

## 15. 成本、限额与常见问题

### 成本预估
- 每个 Agent 调用前都会显示 `costEstimate`，你能看到预估 USD 花费。
- Conductor 计划会汇总整个 DAG 的预估。
- 实际花费记录在 `agent_runs` 表，Analytics 页会展示累计。

### YouTube API 配额
- 免费配额：10,000 单位/天。
- 每次 Discovery 搜索：101 单位（search.list 100 + channels.list 1）。
- 在 `youtube_quota` 表里可查当日用量。

### 定时发布失败
- 检查 Calendar 里该任务的 error_message。
- **瞬时错误**（429、5xx、timeout）：系统会自动按 2→10→30→120 分钟退避重试。
- **输入错误**（缺图、subreddit 名错误等）：立即标 error 不重试，需要你手动修复草稿重发。
- 最多重试次数由任务的 `max_attempts` 字段决定，默认 3 次。

### OAuth 授权过期
- 部分平台（如 TikTok）的 access_token 寿命较短。到期后会出现 401 错误。
- 去 Connections 页，对该平台点 Disconnect → Connect 重新走一次 OAuth 即可。

### 如何降低成本
- 批量操作优于单次（Translate 一次多语言、Conductor 一次规划整条链）。
- 内容生产 `fast` 层对社媒短文案已足够，仅在长文/精品文案时用 `quality`。
- 图像生成关闭不必要的 3K 高清，2K 已能覆盖大多数社媒场景。

### 数据导出
- KOL Database 支持 CSV 导出。
- Analytics 数据可通过 Agent API 拉取（详见未来 Plugin API 规划）。

---

## 附录：术语对照

| 术语 | 含义 |
|---|---|
| **Agent** | 一次 AI 任务的封装单元，有明确输入/输出和成本 |
| **Conductor** | 把自然语言目标拆成多 Agent DAG 并执行的计划器 |
| **Workspace** | 工作区，多租户隔离的最小单位 |
| **Campaign** | KOL 投放活动，聚合一批 KOL 与预算 |
| **Scheduled Publish** | 定时发布任务，由后台 60s 扫描一次 |
| **Intent URL** | 预填好内容的一键发帖链接，不需要 OAuth |
| **Direct Mode** | 通过 OAuth API 直接发帖的模式 |
| **Preset** | 可复用的 Brief 模板 |
| **Tier（fast/quality）** | 模型质量等级，对应不同成本 |

---

*最后更新：2026-04-23*
*如需反馈或报告 Bug，请在 GitHub Issues 提交。*
