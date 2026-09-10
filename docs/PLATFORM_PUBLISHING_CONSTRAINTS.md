# 各平台发布约束调研（2026-09）

> 调研目标：给 `server/scheduled-publish.js` 的排期器一份**真实的配额与成本模型**，以及每个平台"能不能自动发、发了会不会被降权"的答案。
> 这份是**合规发布**视角——官方 API 的额度、价格、外链政策、账号门槛。不涉及规避检测。
> 数据采集于 2026-09-10。**各平台政策变动频繁，超过一个季度请重新核对。**

---

## 0. 结论速查

| 平台 | 官方 API 能发吗 | 主要约束 | 单条成本 | 阻塞项 |
|---|---|---|---|---|
| **X** | ✅ | 按次计费 | **带链接 $0.20 / 纯文本 $0.015** | 无，但贵 |
| **YouTube** | ✅ | 100 次上传/天（独立配额桶） | 免费 | 无 |
| **Instagram** | ✅ | 50–100 条/24h 滚动窗口 | 免费 | 需 Business 账号 + FB 页面 |
| **TikTok** | ⚠️ | **未过审 = 仅自己可见** | 免费 | **必须先过 audit** |
| **Reddit** | ⚠️ | 100 QPM | 商用无自助定价 | **社区自推规则 > API 限制** |
| **Discord** | ✅ | Webhook 无实际限制 | 免费 | 非"发布"，是自有服务器公告 |

---

## 1. X — 计费模型 2026 年初变了，对导流战役影响极大

2026-02-06 起 X 把分级订阅换成了**按次计费**，且**新开发者没有免费额度**。原 Basic（$200/月）的订阅者已于 2026-06-01 后被强制迁移；原 Pro（$5,000/月）于 2026-08-14 宣布弃用，2026-09-01 后陆续迁移。

**价格**：

| 动作 | 单价 |
|---|---|
| 发一条**纯文本**帖 | $0.015 |
| 发一条**带 URL** 的帖 | **$0.20** |
| 读一条帖 | $0.005 |
| 读一个用户资料 | $0.010 |

**这条要单独拎出来**：带链接的帖子是纯文本的 **13.3 倍**价格。而导流战役几乎每条都带链接。

按 umbrella-crasher 战役估算——若一天发 3 条带链接的帖，一个月 90 条 = **$18/月**，可接受；但若按早期设想的 300 账号 × 每天 1 条带链接 = 9000 条/月 = **$1,800/月**，仅 X 一个平台。

**排期器要做的**：把链接放进**首条的回复**而不是主帖，主帖按 $0.015 计费。这同时也符合 X 对外链的降权惯例（主帖带外链会压低分发）。**一举两得，应作为默认策略写进 `adapt.js` 的 x connector。**

---

## 2. YouTube — 2026 年配额改革后反而最宽松

历史上 `videos.insert` 要 1,600 单位，日配额 10,000 单位，等于**一天只能传 6 条**。这是过去所有排期工具的主要瓶颈。

**2025-12-04 起降到约 100 单位；2026-06-01 起进一步改为独立配额桶：`videos.insert` 计 1 单位/次，默认 100 次/天，且不再与读取和搜索抢额度。**

当前默认分配：
- `search.list` — 100 次/天
- `videos.insert` — **100 次/天（独立桶）**
- 其余全部端点合计 — 10,000 单位/天

**结论**：YouTube 现在是这批平台里上传额度最宽松的。Shorts 走同一个 `videos.insert`，竖版 1080×1920 直接传即可。

⚠️ **`search.list` 仍然是 100 单位/次**，100 次就打满一整天的 10,000 单位。KOL discovery 如果用 YouTube 搜索，**必须缓存**——这个坑 InfluenceX 的 scraper 已经踩过（见 `#24`/`#28` 的 URL builder 修复）。

---

## 3. Instagram — 广为流传的"25 条"是过期数字

Meta 现行文档给的是 **100 条/24 小时滚动窗口**（另一处写 50 条），**"25 条"在现行文档里根本不存在**，是旧版残留。

**不要写死任何数字**。正确做法是发布前查账号自己的真实额度：

```
GET /<IG_USER_ID>/content_publishing_limit
```

窗口是**滚动的**——每条发布的额度在 24 小时后各自释放，不是零点统一重置。排期器按滚动窗口算余量，别按自然日。

Reels 和 Stories 计入同一个额度池，但**现行文档没有任何一句明确说明它们的计数方式**，应视为未验证，在自己账号上实测。

**前置条件**：必须是 Instagram Business/Creator 账号，且关联一个 Facebook 页面。个人号无法用 Graph API 发布。

---

## 4. TikTok — 未过审等于发不出去

这是六个平台里唯一一个**默认不可用**的。

**未过审（unaudited）客户端的限制**：
- 所有内容强制 `SELF_ONLY` 可见性 —— **只有作者自己能看**
- 24 小时内最多 5 个用户发布
- 发布时**账号必须处于私密状态**

换句话说，没过 audit 之前，通过 API 发的每一条 TikTok 都是发给自己看的。**这不是限流，是功能上的不可用。**

**过审要什么**：
- 应用注册信息与凭据
- 产品与 scope 配置（Direct Post 需要 `video.publish`）
- **URL 域名归属验证**（Content Posting API 必须）
- App review，**至少一个演示视频**展示完整端到端流程

**排期规划**：audit 有审核周期，赶不上 9/15。**T0 阶段 TikTok 走 `manual_package` 模式**——`packages/social-ops` 的 manual connector 产出粘贴即用的包（标题/正文/标签/封面），人工在 App 里发。等 audit 过了再切 API。

---

## 5. Reddit — API 限制不是真正的约束，社区规则才是

**API 侧**：OAuth 认证客户端 100 QPM per client id，滚动窗口计算，突发可能触发限流。**商业用途不在免费层内，且没有公开的自助定价**——真要商用得走商务联系。

**但真正会卡住你的是社区规则**：

- 绝大多数 subreddit 严格禁止自我推广。**不做实质贡献直接甩产品链接是最快的封号路径。**
- 许多热门 sub 有**账号年龄门槛（常见 30 天）** 和 **karma 门槛（如 100 comment karma）**——这正是为了挡掉单一用途的推广号。

**对本项目的直接含义**：一个刚建的 `u/cuddler_ai` 账号在 30 天内**进不了任何值得进的 sub**。Reddit 不是 T0 渠道，是需要提前 30 天养号（靠真实参与，不是刷）的长线渠道。

**建议**：现在就把账号建起来开始计时，T0 不排 Reddit，9/15+30 天后再评估。

---

## 6. Discord — 定位不同

Discord 没有"向公域发布"这回事，只有**自有服务器内的公告**。用 Webhook 往 `#announcements` 推，没有实际速率瓶颈。

`NOTIFY_DISCORD_WEBHOOK_URL` 已在 `gameclaw-492005` 的 Secret Manager 里。

**注意**：`packages/social-ops/refusals.js` 的 `cold_dm_automation` 明确拒绝自动私信——Discord 的入站 DM 是 agent 能接触到的**最强 prompt-injection 面**。community agent 只拉取入站、分类、起草，**人工逐条批准**。

---

## 7. 对排期器的具体要求

1. **X 的链接放回复，不放主帖** —— 省 13× 成本 + 避开外链降权
2. **Instagram 发布前查 `content_publishing_limit`** —— 不要写死数字
3. **YouTube 搜索必须缓存** —— `search.list` 100 单位/次会打满日配额
4. **TikTok 走 manual_package** —— 直到 audit 通过
5. **Reddit 不进 T0** —— 账号年龄门槛是硬的
6. **每个平台独立的退避与熔断** —— 一个平台 429 不该拖住其余五个

---

## Sources

- [YouTube Data API Overview | Google for Developers](https://developers.google.com/youtube/v3/getting-started)
- [YouTube API Quota Limits 2026 | Phyllo](https://www.getphyllo.com/post/youtube-api-limits-how-to-calculate-api-usage-cost-and-fix-exceeded-api-quota)
- [Instagram API Rate Limits: The Real Caps | bundle.social](https://bundle.social/blog/instagram-api-rate-limits)
- [Instagram Graph API Error 9: The 25-Post Daily Limit | Ayrshare](https://www.ayrshare.com/solutions/instagram-graph-api-error-9-the-25-post-daily-limit-how-to-fix-it/)
- [X (Twitter) API Pricing in 2026: All Tiers | Postproxy](https://postproxy.dev/blog/x-api-pricing-2026/)
- [X (Twitter) API in 2026: Credit Pricing | SocialCrawl](https://www.socialcrawl.dev/blog/x-twitter-api-2026)
- [Direct Post | TikTok for Developers](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- [Content Sharing Guidelines | TikTok for Developers](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [Reddit API Limits, Rules, and Posting Restrictions | Postiz](https://postiz.com/blog/reddit-api-limits-rules-and-posting-restrictions-explained)
- [Reddit API Rate Limits in 2026 | PainPointMap](https://www.painpointmap.com/blog/reddit-api-rate-limits-guide)
