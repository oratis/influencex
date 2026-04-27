# Apify 集成路线图

> influenceX 与 Apify 抓取平台深度整合的完整方案 —— 从填补当前能力缺口到
> 解锁全新产品功能。基于 2026-04-27 对现有 Apify 使用情况和 Apify Store
> 公开目录（26.5K+ actor）的完整审计撰写。
>
> 本文档为 [APIFY_INTEGRATION_ROADMAP.md](APIFY_INTEGRATION_ROADMAP.md)
> 的中文版本，内容保持同步。

---

## 0. 背景

### 这份文档的由来

本路线图源于一次定位生产数据问题的会话：

1. `kol_database` 表里约 150 行 KOL 记录长期卡在 `scrape_status='error'`
   或 `scrape_status='scraping'` —— 是批量 URL 导入失败留下的僵尸数据。
   已通过一次性数据库清理处理掉。
2. 调查过程中暴露出更深层问题：influenceX 的 KOL 抓取链路在没有
   `MODASH_API_KEY` 时会静默失败（影响 Instagram / TikTok / X），而代码
   里已有的 Apify 集成基本是死代码 —— 只在一个调试端点被引用，从来不在
   主流程里跑。

由此引出一个更大的问题：**既然 Apify 提供了 26.5K+ 个现成的爬虫，
influenceX 到底应该怎么用这些能力？** 本文档就是答案。

### 范围

- 仓库内 Apify 代码现状审计
- 能力映射：现有 influenceX 模块 ↔ 适配的 Apify actor
- **Apify 能解锁的全新产品功能**（不仅是补缺）
- 任何方案落地前必须做的架构改造
- 分阶段推进计划，含成本和风险评估
- 相关 actor 参考目录

### 不在范围内

- 替换 Apify 为其他平台（Bright Data、ScrapingBee 等）—— 已决策不换，
  Apify 在 actor 多样性和按结果付费模式上有优势
- 自建爬虫 —— 明确是错误方向；Apify 的核心价值就是它持续维护爬虫对抗
  各平台反爬升级

---

## 1. 现状审计

### 1.1 当前已接入的 Apify 资源

仓库内涉及 Apify 的全部代码：

| 文件 | 用途 | 状态 |
|---|---|---|
| `server/apify-client.js` (135 行) | 包装 `run-sync-get-dataset-items`，硬编码两个 actor：`apify/instagram-profile-scraper`、`clockworks/tiktok-scraper` | 存在但主流程不调用 |
| `server/index.js:36` | `const apify = require('./apify-client')` | 仅导入一次 |
| `server/index.js:2844` | `GET /api/apify/status` 返回 `{ configured }` | 仅探活 |
| `APIFY_TOKEN` 环境变量 | 生产环境通过 Cloud Run secret 注入 | 已激活 |

### 1.2 主流程实际跳过了 Apify

`server/scraper.js` 才是 KOL 实际入库时执行的代码：

- `scrapeInstagram`（line 274）—— 检查 `MODASH_API_KEY`，没有就直接返回
  `{ success: false, error: 'Instagram requires MODASH_API_KEY' }`。**从不
  调用** `apify-client.js` 里的 `apify.scrapeInstagram()`。
- `scrapeTikTok`（line 152）—— 同样模式：先 Modash，再回退到自己写的脆弱
  Open Graph + `__UNIVERSAL_DATA_FOR_REHYDRATION__` HTML 解析器。Apify
  路径是死代码。
- `scrapeX`（line 345）—— 写死返回 `{ success: false, error: 'X/Twitter
  API requires paid access ($100+/month)' }`。Apify 替代品 $0.25/1k tweets
  存在，但没接。
- `scrapeTwitch`（line 289）—— 走 Helix API，需要 `TWITCH_CLIENT_ID/SECRET`。
  生产 Secret Manager 里有，但似乎没生效（74 行卡 4 天 followers=0 就是
  这个原因）。
- `scrapeYouTube`（line 19）—— 走 YouTube Data API v3，受每天 10K 配额限制。

### 1.3 架构性缺陷

1. **只支持同步执行。** `run-sync-get-dataset-items` 有硬性 5 分钟上限。
   批量资料补全、深度 hashtag 抓取，以及任何返回 >100 条结果的 actor 都
   会超时或被截断。
2. **没有 webhook 接收器。** Resend（`/api/webhooks/resend/inbound`，
   `server/index.js:942`）和 Stripe（`/api/billing/webhook`，
   `server/index.js:277`）都各自有 webhook handler。Apify 没有 ——
   异步 actor 完成事件无处可去。
3. **没有 actor 注册表。** 加一个新 actor 就要去改 `apify-client.js`，
   并写一次性归一化代码。我们想接的 actor 大约有 ~25 个，这种模式扩展不了。
4. **没有按 workspace 维度的成本追踪。** Apify 是按结果付费。没有按工作区
   成本归属，就没法限额、也没法准确计费。
5. **没有去重缓存。** `content_scrape_cache` 存在，但用 `content_url` 做键，
   不是 `(platform, username)`。同一周内重复抓同一 KOL 5 次 = 给 Apify
   付 5 次钱。
6. **没有配额保护。** `youtube-quota.js` 给 YouTube Data API 做了配额，
   Apify 花费没有对应机制。一个 Discovery agent 写错了，能在一小时内把
   月预算烧光。
7. **没有批量原语。** 多数 actor 接受数组输入（如 `usernames: ['a','b','c']`），
   但当前客户端只能一个个调。

---

## 2. 能力差距矩阵

influenceX 需要什么 ↔ Apify 提供什么 ↔ 优先级。

| influenceX 模块 / 需求 | 现状 | Apify Actor（推荐） | 单价 | 优先级 |
|---|---|---|---|---|
| **KOL 资料 — Instagram** | Modash-only，没 key 就 fail | `apify/instagram-profile-scraper` | $1.60 / 1k | **P0** |
| **KOL 资料 — TikTok** | Modash → OG 解析回退 | `clockworks/tiktok-profile-scraper`（4.94★ 全店第一） | $2.50 / 1k | **P0** |
| **KOL 资料 — X/Twitter** | 写死 "$100/月付费" stub | `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` | $0.25 / 1k | **P0** |
| **KOL 资料 — YouTube** | Data API v3（10k/天配额） | `streamers/youtube-channel-scraper` | $0.50 / 1k | **P1**（保配额） |
| **KOL 资料 — Twitch** | Helix API（认证有问题） | `automation-lab/twitch-scraper`（无需密钥） | event-based | **P1** |
| **KOL 资料 — LinkedIn** | 完全没有 | `dev_fusion/linkedin-profile-scraper`（带 email 增强） | $10 / 1k | **P2**（需法务） |
| **KOL 发现 — IG / TikTok / X / Reddit** | 仅 YouTube via Data API | `apify/instagram-hashtag-scraper` ($1.90/1k) · `clockworks/tiktok-hashtag-scraper` ($2.00/1k) · `apidojo/twitter-scraper-lite` ($0.40/1k) · `apify/reddit-scraper` ($3.40/1k) | 见左 | **P0** |
| **评论 / Inbox 收集** | `community.js` agent 只接 X，IG/TikTok/Reddit 是 stub | `apify/instagram-scraper`（评论模式）· `clockworks/tiktok-comments-scraper` ($0.50/1k) · `streamers/youtube-comments-scraper` ($0.90/1k) | 见左 | **P1** |
| **竞品内容追踪** | `competitor-monitor.js` 只做网页 fetch + diff | `apify/instagram-post-scraper` · `apify/instagram-reel-scraper` · `clockworks/tiktok-scraper`（profile 模式） | 不一 | **P1** |
| **竞品广告情报** | 无 | `apify/facebook-ads-scraper`（Meta Ad Library，完全合规） | $3.40 / 1k | **P2** |
| **游戏 / 应用评论挖掘** | `review-miner.js` 接受 URL 但无专用 actor | `easyapi/steam-reviews-scraper` · `neatrat/google-play-store-reviews-scraper` · `junglee/amazon-reviews-scraper` | $3 / 1k | **P1**（游戏客户） |
| **SEO / SERP 监控** | `seo.js` 走 SerpAPI | `apify/google-search-scraper` | $1.80 / 1k SERP 页 | **P2** |
| **B2B 邮箱/电话发现** | Hunter.io 只支持 domain 搜索 | `code_crafter/leads-finder` | $1.50 / 1k leads | **P2** |
| **Brand Voice / RAG 内容采集** | `brand_voices` 表手动上传填充 | `apify/website-content-crawler`（markdown 输出） | $0.20–$5 / 1k 页 | **P1** |
| **TikTok 趋势 / 探索** | 无 | `clockworks/tiktok-trends-scraper` · `clockworks/tiktok-discover-scraper` | event-based | **P2** |

---

## 3. Apify 解锁的全新功能

以下是**仓库内目前完全没有的产品能力** —— Apify 是缺失的关键拼图。

### 3.1 趋势雷达（P1）

**卖点：** "在竞争对手注意之前，告诉你什么要爆了。"

**怎么做：** 按区域每小时调度 `clockworks/tiktok-trends-scraper` +
`clockworks/tiktok-discover-scraper` + `apify/instagram-hashtag-scraper`。
对比 hashtag/sound 的速度变化与 7 天滚动基线。前端展示当前增速最快的
20 个标签/音频。

**前端入口：** ContentStudio 下新页 `/trends`。每个趋势卡片包含 (a)
使用该标签的样本帖子，(b) "查找使用该趋势的创作者" → 一键发起预填了
该 hashtag 的发现任务。

**为什么重要：** 现有竞品情报是面向账号的，趋势雷达是面向平台时代精神
的。信号不同，对内容规划更直接可用。

---

### 3.2 赞助贴检测与 KOL 品牌亲和度（P1）

**卖点：** "告诉我哪些 KOL 已经在做付费合作、和谁合作、多久一次。"

**怎么做：** 对每个 campaign 中的 KOL，跑 `apify/instagram-post-scraper`
+ `clockworks/tiktok-scraper`（profile 模式）抓最近 30 条帖子。对文案
应用启发式匹配：`#ad`、`#sponsored`、`#partner`、`@brandname`、
"in partnership with"、平台原生付费合作标签等。建立 `kol_brand_affinity`
表：

```sql
CREATE TABLE kol_brand_affinity (
  kol_id TEXT REFERENCES kol_database(id),
  brand_handle TEXT,        -- 他们 @ 过的品牌
  collab_count INT,         -- 最近 30 条出现次数
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  estimated_paid BOOL       -- 是否带 #ad / 合作标签
);
```

**前端入口：** KOL 详情页的 "近期合作" 区块展示他们合作过的品牌。谈合作
时有用：刚为竞争对手做过 3 条付费贴的 KOL，和从来没做过付费的，谈法不一样。

---

### 3.3 跨平台 KOL 身份解析（P2）

**卖点：** "TikTok 上的 @cozygamerkate 和 IG 上的 @cozygamerkate 是同
一个人吗？谈一次还是两次？"

**怎么做：** 当某 KOL 在某平台被加入时，自动到其他平台跑模糊查找 —
`apify/instagram-scraper`（用户名搜索）、`clockworks/tiktok-user-search-scraper`、
`streamers/youtube-scraper`（搜索模式）、`apidojo/twitter-scraper-lite`。
按用户名相似度 + 显示名 + bio 重合 + 链接 URL 给匹配打分。建立统一的
`kol_identity` 表：

```sql
CREATE TABLE kol_identity (
  master_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  ...
);
ALTER TABLE kol_database ADD COLUMN identity_id TEXT REFERENCES kol_identity(master_id);
```

**前端入口：** KOL 列表把跨平台同一身份合并成一行，显示平台徽章。外联
邮件跨平台去重。

---

### 3.4 声音驱动的发现（P2，TikTok 专属）

**卖点：** "找出所有正在用 [Linkin Park - In the End] 这首歌的创作者。"

**怎么做：** `clockworks/tiktok-sound-scraper` 接受声音 URL，返回最近用该
声音的视频。把所有不重复的创作者抽出来作为临时 cohort，按粉丝量过滤，
批量加入 discovery_results。

**用例：** 品牌想搭一首爆款歌的车。不用手动刷 TikTok，直接拿到一份按
"算法已经选中放大" 自验证的中部创作者排序列表。

---

### 3.5 评论 NLP 推算受众画像（P2）

**卖点：** "不付 Modash 99 美元/月也能拿到 KOL 受众画像。"

**怎么做：** 对目标 KOL，用 `apify/instagram-scraper` 或
`clockworks/tiktok-comments-scraper` 抓最近 20 条帖子的约 1000 条评论。
对评论文本做语种识别 + 情感分析 + 命名实体抽取。启发式估算：
语言分布（区域代理变量）、性别倾向（ICP 适配代理变量）、互动质量
（真粉丝 vs 机器人/水军）。

**注意事项：** 不如 Modash 基于 panel 的 demographics 准确。定位为
"方向性受众信号"，不是 ground truth。

**单 KOL 成本：** 评论抓取 ~$0.50–$1 + LLM token ~$0.10 = **< $1/KOL**，
对比 Modash 99 美元/月。

---

### 3.6 跨区域 KOL 发现（P1，HakkoAI 游戏方相关）

**卖点：** "找该品类下日韩东南亚的创作者。"

**怎么做：** Apify actor 接受 `proxyConfiguration.proxyCountry`。从
东京/首尔/曼谷的 IP 跑 hashtag/discover scraper，挖出美国默认查询里看不到
的本地创作者池。

**为什么不简单：** 平台按观看者国家个性化推荐 feed。从美国 IP 抓
`#indiegame` 主要返回美国创作者，即使我们想要日本创作者。

---

### 3.7 Steam 评论 → KOL 桥（HakkoAI P0）

**卖点：** "你最热心的 Steam 评论者也是个 5 万订阅的 YouTuber，把他招过来。"

**怎么做：** 流水线：

1. `easyapi/steam-reviews-scraper` 拉某游戏（或竞品游戏）的好评 top N。
2. 对每个评论者，跑跨平台身份解析（§3.3）—— Steam handle → 在
   YouTube/Twitch/X 搜匹配用户名。
3. 找到的匹配若粉丝数 > N，自动建 KOL 记录，
   `source = 'steam-review'`，`recruitment_score` = 评论热情 × 创作者体量。
4. 在 "值得招募的死忠粉" Tab 中展示。

**为什么对游戏发行商是金矿：** 这些是已验证的品类粉丝，本来就在做内容。
合作转化率应该远高于冷外联。

---

### 3.8 赞助交付物自动验证（P1）

**卖点：** "KOL 真的发了吗？自动验证。"

**怎么做：** KOL 接受付费合作后，从 `expected_publish_date` 起按周期跑
`apify/instagram-post-scraper`（或对应平台）抓他们的账号。当出现匹配
campaign hashtag/@-mention 的帖子时，标记交付完成，把帖子 URL + 早期
互动数据写入 `roi-dashboard`。

**前端入口：** KOL 合同页显示 "交付物：已发布 ✓ 2026-05-12，12.4K 观看，
890 赞（24h）"。

**已部分存在：** `roi-dashboard.js` 的 schema 已有，Apify 提供的是当前
缺失的验证信号。

---

### 3.9 KOL 相似集群（Lookalike）（P2）

**卖点：** "这 5 个 KOL 转化好。再给我找 50 个类似的。"

**怎么做：** 给定种子 KOL，抓他们的近期评论 + 关注关系（如可得）+
hashtag 共现。在以下维度构建相似搜索：

- Hashtag 重合：5 个种子都用过的标签是哪些？找用过其中 3+ 个的创作者。
- 评论者重叠：频繁评论种子创作者的人是谁？他们往往有自己的粉丝。
- 声音重叠（TikTok 专属）。

按重合度排序，按粉丝数过滤，落到 discovery_results。

---

### 3.10 竞品招聘信号（P3，B2B 向）

**卖点：** "竞品刚发了 3 条 'Influencer Marketing Manager' 招聘，销售
信号。"

**怎么做：** `bebity/linkedin-jobs-scraper` 每天轮询竞争对手公司列表。
检测到与影响力营销 / 内容 / 社区相关的新岗位时，推到 Slack/Notion 作为
销售信号。

**用例：** 间接 —— influenceX 自己 GTM 用得到，对终端客户用处不大。可作为
企业版功能（"意图情报"）。

---

### 3.11 KOL Add 实时回填 UX（P0，体验向）

**卖点：** "粘贴一个 TikTok URL，5 秒后行就填好了。"

**怎么做：** 当前 `POST /api/kol-database` 端点插入一行 `scraping` 状态
记录，再异步触发 `scrapeAndEnrichKol`。配上 §4.1 的 Apify webhook 接收器后，
来回流程变成：

1. 前端：粘贴 URL → `POST /api/kol-database` 立即返回 `id` 和
   `scrape_status: 'scraping'`。
2. 后端：把 Apify run 入队，附带 webhook URL。
3. Apify ~30 秒跑完，调用 `/api/webhooks/apify`。
4. webhook handler 拉 dataset、归一化、把行更新成 `complete`。
5. 前端轮询或 SSE 订阅，行实时填充，不用刷新。

这是体验向功能，但区别是 "粘贴 50 个 URL 然后明天回来看" 和 "粘贴后看着
它一个个填上、马上开始分类处理"。

---

### 3.12 自动 Brand Voice 摄入（P1）

**卖点：** "指着我们博客就行。品牌调性自动捕捉。"

**怎么做：** 用 "爬取我们网站" 向导替代手动上传 `brand_voices`：

1. 用户输入公司 URL。
2. `apify/website-content-crawler` 递归爬取（排除登录页、cookie 弹窗剥除、
   markdown 输出）。
3. 页面分块嵌入到 `brand_voices`（最近的 commit 已 pgvector ready）。
4. Brand voice agent 自动抽取：tone descriptor、常用短语、禁用词、
   定位语句。

**单次配置成本：** 一个典型 100–1000 页站点 ~$0.20–$5。每工作区一次性。

---

### 3.13 合规 / 发布证据快照（P2）

**卖点：** "三个月后你需要证明他们真的发过。我们存了截图。"

**怎么做：** `apify/instagram-post-scraper`（或对应平台）找到交付帖子时
（按 §3.8），同步用 `apify/website-content-crawler`（或带截图模式的
actor）保存截图，存到 GCS，关联到 `kol_contracts` 行。

**用例：** 法务/财务几个月后要执行证据。或者 KOL 在 campaign 中途删了
帖子，你需要证明它跑过。

---

### 3.14 评论回复 QA 闭环（P2）

**卖点：** "Inbox 自动回复发出去了，验证它落地了、有互动。"

**怎么做：** `community.js` agent 已经会在 inbox 消息上起草并发送自动
回复。回复发出后，对该帖子评论流再排一次抓取，确认回复可见（没被影子封禁）、
记录获得的反应。反馈到回复质量模型。

---

### 3.15 行业 lookalike 销售线索（P2）

**卖点：** "给我 500 家欧盟有活跃 Twitter 的独立游戏工作室。"

**怎么做：** `code_crafter/leads-finder`（公司画像过滤）+
`apidojo/twitter-scraper-lite`（handle 查找）+
`apify/instagram-profile-scraper`。输出带验证联系方式 + 活跃社交证据的
销售清单。

**用例：** influenceX 自己外联，或作为面向"创作者营销 SaaS"客户的 B2B
功能。

---

### 3.16 Steam / Play Store 情绪监测（P1，游戏客户）

**卖点：** "你们游戏的评论情绪本周转负，原因如下。"

**怎么做：** 每天对客户游戏跑 `easyapi/steam-reviews-scraper` +
`neatrat/google-play-store-reviews-scraper`。检测情绪变化时刻
（均分下滑、负面关键词激增），通过 Slack/邮件推送 top 5 负面评论样本。

构建在 `review-miner.js` agent 之上 —— 那是一次性分析，这是连续监测。

---

### 3.17 会议 / 活动 KOL 地图（P3）

**卖点：** "GDC 2026 还有 6 周。已经有谁在做相关内容？"

**怎么做：** 对活动标签（#GDC2026、#IndieDevDay）跨 IG/TikTok/X/Reddit
做 hashtag 驱动的发现。按粉丝数过滤。输出"已经在做活动相关内容的人"
名单，用于赞助外联。

---

### 3.18 失败 / 清理 Watchdog（P0，运维）

**卖点：** 别让僵尸抓取行堆积。

**怎么做：** Cron 任务（用现有 `scheduler.js`）每小时跑：

```sql
UPDATE kol_database
SET scrape_status = 'error',
    scrape_error = 'Stuck >24h, marked as failed'
WHERE scrape_status = 'scraping'
  AND created_at < NOW() - INTERVAL '24 hours';
```

外加 `/api/admin/apify-runs` 视图给运维查失败 run 并重试。

这直接从结构上防止本文档诞生原因 —— "78 + 74 = 152 行僵尸数据"问题。

---

### 3.19 KOL 互动预测（P2）

**卖点：** "如果与该 KOL 合作，预计 48 小时内 8000–15000 次播放。"

**怎么做：** 对目标 KOL 用 `clockworks/tiktok-scraper`（profile 模式）
或对应 actor 抓最近 50 条帖子。计算基线互动分布（plays/likes/comments
的中位数、p25、p75）。训练一个简单模型纳入：帖子衰减、hashtag 适配度、
赞助 vs 自然内容差异、星期效应。

输出：新合作的预期触达区间。在 campaign 规划时展示。

---

### 3.20 全网品牌声量爬虫（P1）

**卖点：** "本周互联网上谁在讨论我们？"

**怎么做：** 多 actor 品牌声量管线：

- `apify/google-search-scraper` 全网品牌提及（query：
  `"brand_name" -site:brand.com`）
- `apify/reddit-scraper` 抓 subreddit / 评论提及
- `apidojo/twitter-scraper-lite` 抓 X 提及
- `apify/instagram-scraper`（搜索模式）
- `apify/website-content-crawler` 在新闻域名抓媒体提及

汇总到 "提及收件箱"，带情感 + 作者 + 触达信号。本质上是基于 Apify 自建一个
Brand24 / Mention.com 的竞品。

---

## 4. 架构基础

任何 actor 集成上规模前必须先做的事，没得商量。

### 4.1 异步 + Webhook 执行管线

把 `server/apify-client.js` 重构为支持三种调用模式：

```js
// 1. 同步 — 短任务（<60s），保留现有 API 向后兼容
runActorSync(actorId, input, opts)

// 2. 异步 + 轮询 — 长任务，调用方愿意 block
const { runId, datasetId } = await runActorAsync(actorId, input)
await waitForCompletion(runId)  // 轮询 /v2/actor-runs/{runId}

// 3. 异步 + Webhook — fire and forget，webhook handler 收尾
await runActorWithWebhook(actorId, input, {
  webhookUrl: `${BASE_URL}/api/webhooks/apify`,
  callbackTarget: 'kol_database',
  callbackPayload: { kolId },
})
```

新增 `POST /api/webhooks/apify`，参考 Resend / Stripe handler 的写法。

### 4.2 持久化：`apify_runs` 表

```sql
CREATE TABLE apify_runs (
  id TEXT PRIMARY KEY,                      -- Apify runId
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT NOT NULL,                   -- 例如 'apify/instagram-scraper'
  purpose TEXT,                             -- 'kol-discovery' | 'profile-enrich' | ...
  input JSONB,
  status TEXT,                              -- READY | RUNNING | SUCCEEDED | FAILED | TIMING_OUT | TIMED_OUT | ABORTED
  dataset_id TEXT,
  cost_usd REAL,                            -- 来自 /actor-runs/{id}.usage.totalUsd
  callback_target TEXT,                     -- 结果落到哪张表
  callback_payload JSONB,                   -- 例如 { kol_id, campaign_id }
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_apify_runs_workspace_status ON apify_runs(workspace_id, status);
CREATE INDEX idx_apify_runs_actor ON apify_runs(actor_id);
```

### 4.3 Actor 注册表与输出归一化

新建 `server/apify-actors/`：

```
server/apify-actors/
  index.js                       # 注册表 { id → adapter }
  _base.js                       # 共享工具
  instagram-profile.js           # { actorId, normalize(rawItem) → KolRow }
  instagram-hashtag.js
  instagram-post.js
  instagram-comments.js
  instagram-reel.js
  tiktok-profile.js
  tiktok-hashtag.js
  tiktok-comments.js
  tiktok-trends.js
  tiktok-sound.js
  twitter-profile.js
  twitter-search.js
  youtube-channel.js
  youtube-comments.js
  reddit-search.js
  twitch-channel.js
  facebook-ads.js
  linkedin-profile.js            # P2，需法务签字
  steam-reviews.js
  play-store-reviews.js
  app-store-reviews.js
  amazon-reviews.js
  google-search.js
  website-content.js
  leads-finder.js
```

每个 adapter 导出：

```js
module.exports = {
  actorId: 'apify/instagram-profile-scraper',
  defaultInput: (params) => ({ usernames: [params.username], resultsLimit: 1 }),
  normalize: (rawItem) => ({                // → kol_database schema
    platform: 'instagram',
    username: rawItem.username,
    display_name: rawItem.fullName,
    avatar_url: rawItem.profilePicUrlHD,
    followers: rawItem.followersCount,
    // ...
  }),
  estimatedCostPer: 'profile',              // 配额计算用
  estimatedCostUsd: 0.0016,
};
```

加新 actor = 丢一个文件，不动 `apify-client.js` 也不动业务代码。

### 4.4 缓存层

扩展 `content_scrape_cache` 或新增 `kol_profile_cache`：

```sql
CREATE TABLE kol_profile_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  platform TEXT,
  username TEXT,
  data JSONB,              -- 归一化后的 KolRow
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE (platform, username)
);
```

`server/scraper.js` 的 `scrapeProfile` 先查 cache。TTL：免费/低端套餐 7 天，
付费套餐 1 天（按 workspace plan 配置）。

### 4.5 成本追踪与配额

照搬 `youtube-quota.js`：

```js
// server/apify-quota.js
const PLAN_LIMITS = {
  starter:   { monthly_usd: 5 },
  growth:    { monthly_usd: 50 },
  enterprise:{ monthly_usd: null }, // 无上限
};

async function canRun(workspaceId, estimatedUsd) {
  const used = await getMonthlySpend(workspaceId);
  const limit = PLAN_LIMITS[plan].monthly_usd;
  if (limit !== null && used + estimatedUsd > limit) {
    return { allowed: false, used, limit };
  }
  return { allowed: true, used, limit };
}
```

阻断会超额的 actor run。在 workspace settings UI 显示用量：
"本月已用 $4.20 / $5"。

### 4.6 失败 Watchdog（已在 §3.18 覆盖）

Cron 任务把超过 24 小时的 `scraping` 行标记为 `error`，再加运维仪表盘
`/api/admin/apify-runs` 看最近失败。

---

## 5. 分阶段路线

### Phase A — 救活 KOL 资料抓取（第 1–2 周）

**目标：** 让 IG / TikTok / X 资料抓取在没有 `MODASH_API_KEY` 的情况下也
能跑。每个客户都受影响。

**范围：**
- §4.1 异步框架 + webhook 接收器
- §4.2 `apify_runs` 表
- §4.3 最小注册表（4 个 adapter：ig-profile、tiktok-profile、
  twitter-profile、youtube-channel）
- §4.4 缓存层
- §4.5 成本追踪（v1 阻断模式可选）
- §4.6 watchdog cron
- 重写 `scraper.js` 路由：`Apify > Modash > 直接 fetch > error`
- 把刚清掉的 152 行重新跑一次验证

**成功指标：**
- IG / TikTok / X 资料抓取在没有 Modash 的情况下成功率 95%+
- 资料增强 p95 延迟 < 60s
- 没有新增 "stuck >24h" 行

---

### Phase B — 多平台发现（第 3–4 周）

**目标：** 把发现能力从 YouTube 扩展到 IG / TikTok / X / Reddit。

**范围：**
- 4 个新 adapter：ig-hashtag、tiktok-hashtag、twitter-search、reddit-search
- `discovery.js` agent 加 `platform` 输入参数（多选，默认 = 所有已配置）
- 前端：发现页加平台多选器
- 把 §3.6（区域代理支持）烤进 adapter 配置

**成功指标：**
- "indie gaming" 跨平台发现一次返回 200+ 候选
- 单次成本 < $2

---

### Phase C — Inbox / 社区收集（第 5 周）

**目标：** 把 `community.js` agent 的 IG/TikTok/Reddit stub 变成真实 handler。

**范围：**
- 4 个 comments adapter：ig-comments（用 `apify/instagram-scraper` 评论
  模式）、tiktok-comments、youtube-comments、reddit-comments
- 增量抓取：每个 (workspace, kol_id) 用 `since_timestamp` 游标避免重复扣费
- 接到现有 `inbox_messages` 表

---

### Phase D — 评论与游戏/应用情绪（第 6 周，游戏客户）

**目标：** §3.7（Steam-reviews → KOL 桥）和 §3.16（情绪监测）。

**范围：**
- 3 个评论 adapter：steam、play-store、app-store
- 扩展 `review-miner.js` agent 加 `platform` + `app_id` 路由
- §3.7 跨平台桥接逻辑
- §3.16 每日情绪 delta cron + 告警通道（Slack / Feishu，两者都已存在）

---

### Phase E — 品牌与竞品情报（第 7–8 周）

**目标：** 程序化 brand-voice 摄入 + 竞品广告库 + 赞助贴检测。

**范围：**
- §3.12 brand-voice 自动摄入（apify/website-content-crawler →
  brand_voices RAG）
- §3.2 赞助贴检测（`kol_brand_affinity` 表 + UI）
- Facebook Ads Library adapter 接到 `competitor-monitor.js`
- 前端：KOL 详情页加 "近期合作" 区块

---

### Phase F — 全新功能（第 9 周+）

按 HakkoAI / 游戏垂类客户的 ROI 排序：

1. §3.7 Steam → KOL 桥（HakkoAI P0）
2. §3.20 全网品牌声量爬虫
3. §3.1 趋势雷达
4. §3.8 赞助交付物验证（闭环 ROI dashboard）
5. §3.5 评论 NLP 受众画像
6. §3.11 实时填充 KOL Add UX
7. §3.9 相似集群
8. §3.4 声音驱动发现
9. §3.3 跨平台身份解析
10. §3.19 互动预测
11. §3.13 合规快照
12. §3.17 活动 KOL 地图
13. §3.10 招聘信号销售线索
14. §3.14 评论回复 QA
15. §3.15 行业 lookalike 销售线索

---

## 6. 成本模型

假设：100 个客户工作区，中等使用量。

| 用法 | 月度量 | Apify 成本 | 备注 |
|---|---|---|---|
| KOL 资料抓取 | 30/ws × 100 = 3K，70% 缓存命中 → 实际调用 900 | ~$2 | IG/TikTok/X 混合 |
| 发现扫描（跨平台） | 4 次/ws × 100 = 400 次 × ~$1.20/次 | $480 | hashtag + search 跨 4 平台 |
| 评论收集（活跃 KOL） | 5 万条 | ~$30 | 主要 IG + TikTok |
| 评论抓取（30% 游戏客户） | 2 万条 | $60 | Steam + Play Store |
| Brand voice / RAG 爬取 | 5K 页 | $10–25 | 每工作区一次性 |
| SERP 监控（部分替换 SerpAPI） | 5K 查询 | $9 | 可选 |
| 全网品牌声量管线 | 1 万结果 | $25 | 多 actor 扇出 |
| **合计** | | **~$620–650 / 月** | |

**对比当前 Modash 花费：** Modash 起步 $99/月每席位 + 用量。100 个工作区
即使每个 1 席，基线就是 ~$10K/月再加每次调用费。**Apify 替换在这一项
能省 90%+**，且覆盖 Modash 不支持的平台（X、Reddit、Twitch、Steam reviews、
Google Maps、Ad Library）。

**按套餐分摊每工作区成本（建议计费）：**
- Starter（$29/月）：$5 Apify 上限，超额阻断
- Growth（$99/月）：$50 Apify 上限，超额阻断
- Enterprise：不计量，真实成本透传

---

## 7. 风险与对策

### 7.1 Apify 也在和反爬作斗争

IG / X / TikTok 的反爬持续升级。即使是维护良好的 actor 也会有失败高峰。
**对策：**

- 所有抓取调用双链路：Apify → fallback（如有 Modash key 就用 Modash /
  直接 fetch / error）。路由逻辑放在 `scraper.js`（Phase A）。
- `apify_runs.status` 监控；某 actor 24h 失败率 > 20% 自动切主路由并
  on-call 告警。

### 7.2 LinkedIn 法务风险

LinkedIn UA 明确禁止抓取。`dev_fusion/linkedin-profile-scraper` 存在且
能用，但用它有诉讼风险（hiQ Labs v. LinkedIn 案为公开 profile 数据提供
了一些保护，但法律环境在演进）。**对策：**

- Phase F 的 LinkedIn adapter 默认禁用
- 仅企业版可用，需单独 opt-in
- 法务审查文档化，按 workspace 启用
- 任何情况下不抓登录后的内容

### 7.3 成本失控

按结果付费 + 写错的发现 agent = 一小时烧光预算。**对策：**

- §4.5 配额保护必须在任何 actor 上生产前就到位
- 所有套餐默认有每工作区上限
- 每 actor 小时级限速（例如每工作区每小时最多 1000 结果）
- Cost preview UI："本次任务预计花费 ~$0.40"，用户点 Run 前看到

### 7.4 生产数据污染（本文档诞生的原罪）

批量 URL 导入落地为 `scrape_status='scraping'` 然后从不解决。**对策：**

- §4.6 watchdog cron 自动标记僵尸行
- §4.1 webhook 架构让 "完成事件" 可靠，不是靠 setTimeout 祷告
- 运维仪表盘排查失败

### 7.5 邮箱/电话的 PII / GDPR

Apify 的 lead-finder + LinkedIn enrichment 会暴露邮箱和电话。**对策：**

- 所有 PII 字段用 `MAILBOX_ENCRYPTION_KEY` 加密入库（已有 mailbox 表的
  既定模式）
- 按 workspace 数据保留策略：删除工作区时邮箱可清除
- 不向非管理员角色暴露原始 enrichment 数据

### 7.6 锁定 Apify

如果 Apify 涨价或关停，发现 + 增强能力一夜瘫痪。**对策：**

- `scraper.js` 路由层保持抽象 —— Apify 只是其中一家供应商，Modash 是
  另一家
- Adapter 模式（§4.3）让换供应商 = 每平台一个文件，不是大重构
- 承认现实：没到月花费 >$5K 不值得做完整供应商冗余

---

## 8. 开放问题

1. **Modash 留不留：** 把 Modash 留作 fallback（多花 $99/月，但 Apify 跑
   通时基本没用）还是直接停？建议 Phase A 后继续保留 1 个季度验证 Apify
   成功率，再下线。
2. **自托管 Apify 代理？** Apify 提供代理租赁。区域发现（§3.6）值得，但
   单次调用成本会 +30%。
3. **MCP server 路线：** Apify 最近通过 MCP 暴露 actor。能不能直接把
   actor 作为 MCP 工具接到 agents-v2，而不是自己写 adapter 层？取舍：
   归一化控制力差点，但能瞬间拿到全店 catalog。
4. **Webhook 签名校验：** Apify webhook 支持 HMAC 签名。确认我们处理前
   会校验（参考 Stripe / Resend handler）。
5. **定价透传模型：** 客户看到 Apify 成本作为 line item（"发现扫描：
   $1.20"）还是吸收进套餐价？建议吸收进套餐价，硬上限 + 透明用量 UI。

---

## 9. 第一周冲刺日程

如果立项，第一周长这样：

**Day 1–2：** §4.1 异步框架 + webhook handler + `apify_runs` 表 migration。
PR：`feat(apify): async runtime + webhook receiver`。

**Day 3：** §4.3 注册表 + 4 个最小 adapter（ig-profile、tiktok-profile、
twitter-profile、youtube-channel）。PR：`feat(apify): actor registry + 4
profile adapters`。

**Day 4：** §4.4 缓存层 + §4.5 成本追踪（v1 只读，先不阻断）。
PR：`feat(apify): profile cache + cost tracking`。

**Day 5：** 重写 `scraper.js` 路由。在 staging 把 152 行清过的重新跑一遍。
PR：`refactor(scraper): route via Apify when configured`。

**Day 6–7：** §4.6 watchdog cron + 运维仪表盘。生产环境功能开关后
（`APIFY_ROUTING=primary` 环境变量）发布，监控 48 小时。

**冲刺末交付：** 每个客户的资料抓取链路在没有 Modash 的情况下能跑、
152 行数据污染问题从结构上解决、Phase B–F 的基础打好。

---

## 附录 A：Actor 目录（与 influenceX 相关）

### 社交媒体 — 资料 / 发现 / 内容

| Actor ID | 平台 | 能力 | 价格 |
|---|---|---|---|
| `apify/instagram-scraper` | Instagram | 全功能：profile、post、hashtag、comment | $1.50/1k |
| `apify/instagram-profile-scraper` | Instagram | 仅 profile | $1.60/1k |
| `apify/instagram-post-scraper` | Instagram | 帖子 | $1.00/1k |
| `apify/instagram-reel-scraper` | Instagram | Reels | $1.00/1k |
| `apify/instagram-hashtag-scraper` | Instagram | hashtag feed | $1.90/1k |
| `apify/instagram-followers-count-scraper` | Instagram | 仅粉丝数 | $1.30/1k |
| `clockworks/tiktok-scraper` | TikTok | 混合输入 | $1.70/1k |
| `clockworks/tiktok-profile-scraper` | TikTok | profile 级（4.94★） | $2.50/1k |
| `clockworks/tiktok-comments-scraper` | TikTok | 评论 | $0.50/1k |
| `clockworks/tiktok-hashtag-scraper` | TikTok | hashtag feed | $2.00/1k |
| `clockworks/tiktok-trends-scraper` | TikTok | 上升趋势 | event-based |
| `clockworks/tiktok-discover-scraper` | TikTok | 探索 feed | event-based |
| `clockworks/tiktok-sound-scraper` | TikTok | 用某声音的视频 | event-based |
| `streamers/youtube-scraper` | YouTube | 混合（频道、视频、搜索） | $2.40/1k |
| `streamers/youtube-channel-scraper` | YouTube | 仅频道（最便宜） | $0.50/1k |
| `streamers/youtube-comments-scraper` | YouTube | 评论 | $0.90/1k |
| `streamers/youtube-shorts-scraper` | YouTube | Shorts | $2.40/1k |
| `codepoetry/youtube-transcript-ai-scraper` | YouTube | 字幕（Whisper 兜底） | $0.70/1k |
| `apidojo/twitter-scraper-lite` | X | 混合（搜索、profile、list、对话） | event-based |
| `apidojo/tweet-scraper`（V2） | X | 高级搜索 | $0.40/1k |
| `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` | X | 最便宜 | $0.25/1k |
| `epctex/twitter-profile-scraper` | X | 仅 profile | $10/月 + 用量 |
| `apify/facebook-pages-scraper` | Facebook | 主页元数据 | $10/1k |
| `apify/facebook-posts-scraper` | Facebook | 主页帖子 | $2/1k |
| `apify/facebook-ads-scraper` | Facebook | Meta Ad Library（合规） | $3.40/1k |
| `apify/facebook-groups-scraper` | Facebook | 公开 group | $2.60/1k |
| `apify/reddit-scraper` | Reddit | 全功能 | $3.40/1k |
| `trudax/reddit-scraper-lite` | Reddit | 同上（备选） | $3.40/1k |
| `automation-lab/twitch-scraper` | Twitch | 直播、profile、游戏（无需 auth） | event-based |
| `dev_fusion/linkedin-profile-scraper` | LinkedIn | profile + email 增强 | $10/1k |
| `harvestapi/linkedin-profile-search` | LinkedIn | 过滤搜索 | $0.10/页 + $0.004/profile |
| `harvestapi/linkedin-company` | LinkedIn | 公司信息 | $3/1k |
| `harvestapi/linkedin-company-employees` | LinkedIn | 公司员工列表 | 不一 |
| `bebity/linkedin-jobs-scraper` | LinkedIn | 招聘岗位 | $29.99/月 + 用量 |
| `nocodeventure/bluesky-scraper` | Bluesky | 通过 AT Protocol 抓 post/profile | event-based |

### 评论与电商

| Actor ID | 数据源 | 用途 | 价格 |
|---|---|---|---|
| `easyapi/steam-reviews-scraper` | Steam | 游戏评论 | event-based |
| `neatrat/google-play-store-reviews-scraper` | Play Store | App 评论 | event-based |
| `junglee/amazon-crawler` | Amazon | 商品 | $3/1k |
| `junglee/amazon-reviews-scraper` | Amazon | 商品评论 | $3/1k |
| `compass/crawler-google-places` | Google Maps | 地点 | $2.10/1k |
| `compass/google-maps-reviews-scraper` | Google Maps | 评论 | $0.30/1k |
| `lukaskrivka/google-maps-with-contact-details` | Google Maps | 地点 + 邮箱 | $2.10/1k |

### 搜索 / 网页 / RAG

| Actor ID | 用途 | 价格 |
|---|---|---|
| `apify/google-search-scraper` | Google SERP（自然结果、广告、PAA、AI Mode） | $1.80/1k |
| `apify/website-content-crawler` | 爬网站 → markdown 喂 LLM | $0.20–$5/1k 页 |

### Lead generation

| Actor ID | 用途 | 价格 |
|---|---|---|
| `code_crafter/leads-finder` | B2B 个人 + 公司搜索（Apollo/ZoomInfo 替代） | $1.50/1k |

---

## 附录 B：调研出处

本路线图调研引用：

- [Apify Store 首页](https://apify.com/store)
- [Best Apify Social Media Scrapers 2026](https://use-apify.com/docs/best-apify-actors/best-social-media-scrapers)
- [Best Apify Actors hub 2026](https://use-apify.com/docs/best-apify-actors)
- [apify/instagram-scraper](https://apify.com/apify/instagram-scraper)
- [clockworks/tiktok-scraper](https://apify.com/clockworks/tiktok-scraper)
- [streamers/youtube-scraper](https://apify.com/streamers/youtube-scraper)
- [apidojo/tweet-scraper](https://apify.com/apidojo/tweet-scraper)
- [dev_fusion/linkedin-profile-scraper](https://apify.com/dev_fusion/linkedin-profile-scraper)
- [apify/google-search-scraper](https://apify.com/apify/google-search-scraper)
- [code_crafter/leads-finder](https://apify.com/code_crafter/leads-finder)
- [apify/website-content-crawler](https://apify.com/apify/website-content-crawler)
- [Apify Webhooks complete guide 2026](https://use-apify.com/blog/apify-webhooks-complete-guide)
- [Apify run-actor patterns docs](https://docs.apify.com/academy/api/run-actor-and-retrieve-data-via-api)

仓库内引用：

- `server/apify-client.js` —— 当前最小客户端
- `server/scraper.js` —— 主流程抓取代码，Apify 在这被绕过
- `server/agents-v2/` —— 受益于 Apify 集成的 agent（community、
  competitor-monitor、discovery、review-miner、seo）
- `server/index.js:2844` —— 当前 `/api/apify/status` 端点
- `server/index.js:942` / `server/index.js:277` —— Resend / Stripe webhook
  模式，Apify 接收器照搬

---

*最后更新：2026-04-27。Owner：待定。状态：提案。*
