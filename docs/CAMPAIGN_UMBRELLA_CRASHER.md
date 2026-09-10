# 战役：Umbrella Crasher

> 把一支 14.4 秒竖版样片投进已排好的 Cuddler 9/15 T0 launch，导流到对应 scene 页。
> 与 Cuddler 侧 `docs/gtm_social_accounts_setup.md` / `marketing/x-launch-plan.html` / `docs/marketing_plan.md` 是同一场 launch 的组成部分，**不另起节奏**。
> 最后更新：2026-09-10。

---

## 1. 素材

| 项 | 值 |
|---|---|
| 文件 | `~/Downloads/社媒样片-umbrella-crasher-1080x1920.mp4` |
| 规格 | H.264 / **1080×1920（9:16）** / 30fps / AAC |
| **时长** | **14.4 秒** |
| 大小 | 16.6 MB（9.2 Mbps） |

14.4 秒是个好长度——**六个平台的竖版位全部通吃**，不需要重剪：YouTube Shorts（<60s）、IG Reels、TikTok、X 竖版视频均可直接用。

**落地页**：`https://cuddler.ai/scene/umbrella-crasher-cmtu6fuqb00q023yn6s50ead4`（实测 200，标题 `Umbrella Crasher | Cuddler`）

---

## 2. 落地页归因面：三个要修的点

实测该 scene 页的 OG / Twitter card：

| 发现 | 影响 | 建议 |
|---|---|---|
| `og:video` 是 **1280×720 横版** | 分享卡片里的预览与实际投放的竖版素材比例不一致，观感割裂 | scene 页按主素材比例出 `og:video`，或竖版内容单独给一套 |
| `twitter:card` = `summary_large_image` | **X 上不会内嵌播放**，只出静态大图 | 视频类 scene 改用 `player` card（需向 X 申请 player card 域名白名单） |
| `og:url` 是裸链，无归因参数位 | 分享出去的链接无法区分来源 | 按 `marketing_plan.md` §3.1 走短链 |

`og:image` 走 `https://cuddler.ai/api/scenes/{id}/card`（1200×630）是对的，无需改。

---

## 3. 链接与归因

**硬规则（来自 `marketing_plan.md` §3.1）**：外发视频一律走 `share/create` 出品牌片（结局卡 + 短链），**不手动导原片**，否则归因断链。

短链格式：
```
https://cuddler.ai/s/{id}?utm_campaign=content:<account>
```

**建议为本战役单独开一个 campaign 值**，例如 `content:umbrella-crasher`，这样 ROI dashboard 能把这支片的漏斗单独拉出来，而不是混在 launch 大盘里。

---

## 4. 分平台投放

约束依据见 [PLATFORM_PUBLISHING_CONSTRAINTS.md](./PLATFORM_PUBLISHING_CONSTRAINTS.md)。

| 平台 | 形态 | 链接放哪 | 备注 |
|---|---|---|---|
| **YouTube** | Shorts | 描述位**第一行** | 上传额度充裕（100/天独立桶）；**Made for kids 选「否」** |
| **Instagram** | Reels | bio link + 帖内提及 | IG 正文不可点；发布前查 `content_publishing_limit` |
| **X** | 竖版视频帖 | **放首条的回复，不放主帖** | 省 13× 成本 + 避外链降权，见下 §5 |
| **TikTok** | 原生 | bio link | **走 `manual_package` 人工发**，audit 未过 |
| **Discord** | `#announcements` | 直接贴 | 自有服务器，无限制 |
| **Reddit** | — | — | **不进 T0**，账号年龄门槛 30 天 |

---

## 5. X 的成本策略

X 自 2026-02 起按次计费：**纯文本帖 $0.015，带 URL 的帖 $0.20**——13.3 倍差价。

**策略**：主帖发视频不带链接（$0.015），链接放自己的第一条回复（$0.20），总计 $0.215。看起来没省，但——

- 主帖不带外链，**分发不被压制**（X 对主帖外链的降权是长期惯例）
- 后续所有引用、转发都指向主帖，只付一次链接钱
- 若一天 3 条带链接的帖，月成本约 $18；**这个量级是可接受的，前提是不要按账号数量放大**

**应写进 `packages/social-ops/connectors/x.js` 的默认行为**，而不是每次战役手工决定。

---

## 6. 排期

锚定 Cuddler 已定的 launch 节奏（T0 = 2026-09-15）：

| 时间 | 动作 |
|---|---|
| **T-5 ~ T-3** | 建号（见 [ACCOUNT_MATRIX.md](./ACCOUNT_MATRIX.md) §7）；Reddit 号即刻注册开始养 |
| **T-3（9/12）** | 预告帖（X + YouTube 社区帖），**不带本片** |
| **T0（9/15）** | 主线程 T1–T7 + 联动片；**umbrella-crasher 作为 Wave 2 素材，不与主线程抢位** |
| **T+1 ~ T+4** | YouTube Shorts / IG Reels / X 竖版帖依次投放，各平台错开 1 天 |
| **T+7** | 读回数据（`fetchMetrics`），决定是否加投 |
| **T+30** | Reddit 账号满 30 天，评估是否进相关 sub |

**不要六平台同日齐发**。错开的理由不是怕被发现，是**便于归因**——同日齐发无法判断哪个平台带来了转化，而这正是这支片子作为"样片"要回答的问题。

---

## 7. 内容生成

走 `server/agents-v2/content-text` + `packages/social-ops/adapt.js`：

- **多语种**：Cuddler 支持 10 语种，但**首轮只做 EN + ZH**——其余语种没有对应运营人力校对，机翻文案的品牌损伤大于增量曝光
- **文案过词表**：Cuddler 侧对外文案有词表约束（`pnpm copy:check`），本战役文案应同样过一遍
- **场景描述可直接复用**落地页的 `og:description`：*"Rain hits the street without warning, and you find your umbrella suddenly shared…"*

---

## 8. 待办

- [ ] scene 页补竖版 `og:video`，视频类 scene 评估 `player` card
- [ ] 开 `content:umbrella-crasher` 短链与 campaign 值
- [ ] `x.js` connector 默认「链接放回复」
- [ ] EN + ZH 文案生成并过词表
- [ ] 按 §6 排期录入 scheduler
- [ ] T+7 读回数据
