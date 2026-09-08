# 社媒运营能力层（`packages/social-ops`）

> **状态**：✅ v0.1 已落地（2026-09-08）· 54 个单测 · 服务端 X / IG / YouTube / TikTok / Reddit 发布已委托给它
> **触发**：owner 指令「和 Cuddler 联合建设社媒运营 agent 能力：Cuddler 是私有项目、存连接与操作；InfluenceX 是能力层、不持密钥、能力沉淀在这里」
> **姊妹文档**：Cuddler 仓 `docs/design_social_ops_joint_build.md`（分工、平台矩阵裁决、接入合同、分期）· 本仓 [`PLUGIN_API_v0.md`](PLUGIN_API_v0.md)（agent 插件形状）· [`ROADMAP.md`](ROADMAP.md) Phase C / G

---

## 0. TL;DR

1. **能力沉淀在一个零依赖的子包里**：`packages/social-ops`（npm 名 `@influencex/social-ops`）。它**不读 `process.env`、不读库、不开浏览器**——所有凭据都是函数入参，所有平台拒绝都是返回值而非异常。这一条有测试守着（`social-ops-capabilities.test.js` 扫描全包源码）。
2. **12 个平台一张矩阵**：X · Instagram · Discord · Reddit · YouTube · TikTok · 小红书 · 微信视频号 · 微信公众号 · B 站 · 抖音 · 快手。每个平台有一个 `publishMode`：`api_direct`（能直接发）/ `api_draft`（只能落草稿箱，人来点发布：公众号）/ `manual_package`（无第三方发布 API，产出可粘贴的校验过的物料包：小红书、视频号）。
3. **服务端只保留一份实现**：`server/publish/oauth.js` 里 X / IG / YouTube / TikTok / Reddit 的 `publish*` 已改成薄委托（`legacyResult()` 保旧返回形状），既有 679 个测试 + 新增 54 个全绿。
4. **四项目标能力的裁决**（详见 §2）：官方号自动化 ✅ · 社群发帖 ✅（贡献优先 7:1 + 明示身份 + 尊重版规）· EDM ✅（自有域名 + 合规 ESP + 同意制名单）· **bot 号矩阵 / 批量注册邮箱 / 冷 DM 群发 ✗**，用 `REFUSALS` 表在 manifest 里对外声明并给出替代能力。
5. **宿主（Cuddler）负责**：凭据加密存储、OAuth 同意页由账号持有人本人点、帖子状态机与幂等、Cloud Scheduler 调度与限速、发布前人审。`manifest().hostResponsibilities` 把这五条写死。

---

## 1. 分工边界

| | InfluenceX（能力层，公开仓） | Cuddler（宿主，私有仓） |
|---|---|---|
| 凭据 | **不持有**。client id/secret、access/refresh token 全部作为入参 | Secret Manager（client secret）+ `SocialAccount` 加密列（token） |
| OAuth | 纯函数：拼授权 URL、换 code、刷新 token | 后台按钮 → 持有人浏览器 → 回调落库 |
| 发布 | connector：校验 → 调官方 API → 归一化结果 | 状态机（draft→approved→publishing→published）、幂等 CAS、重试策略 |
| 内容 | pipeline：brief→plan→copy→visual→adapt→词表闸（LLM 注入） | 素材选取（Scene/Drama/Webtoon）、`share/create` 品牌片、nano banana、口径词表 |
| 度量 | `fetchMetrics` 归一化（拿不到就 `available:false`，不是错） | `SocialPostMetric` 时序快照、短链漏斗、BQ 复盘 |
| EDM | 合规地板、同意过滤、抑制名单、预热、熔断、可续跑的发送循环（`send` 注入） | `EmailCampaign` + Resend + 退订 token + 受众查询 |
| 社群 | 贡献账本、版规判读、明示身份、Discord slowmode | 账本持久化、哪个社区、什么时候 |
| 多账号 | `matrix.validateAccountProfile`（拒绝 bot/代理池形状）+ `planStagger` | 账号台账、持有人、授权记录 |

**接入方式**：宿主把这个目录当依赖装进自己的进程（`pnpm add github:oratis/influencex#path:packages/social-ops` 或发布到 npm 后 `@influencex/social-ops`），凭据从不离开宿主进程。**不走 HTTP**——走 HTTP 就意味着 token 要经过能力层的进程，违背「能力层没有连接密钥」这条分工。

---

## 2. 四项目标能力的裁决

| 目标 | 裁决 | 能力层提供 | 不做的部分与理由 |
|---|---|---|---|
| **A 官方号自动化 + 内容制作流程** | ✅ 全做 | `connectors`（12 平台）+ `pipeline` + `adapt` + `oauth` | — |
| **B 用 IP 库 + agent 批量建 bot 号做发帖/评论/DM 营销** | ✗ **不做** | 替代：`matrix/policy` —— 自有账号矩阵（品牌主号 / 地区号 / 主题号 / 员工号 / 签约创作者号），每个号有人类持有人、明示身份、平台授权由持有人本人给；`planStagger` 错峰 | 12 个平台的规则全部把「协同虚假行为」列为封号项，且封禁按 IP / 设备 / 支付 / 恢复邮箱连坐到官方号；美国 FTC 16 CFR Part 465（2024）与网信办《网络信息内容生态治理规定》第二十四条都把它定为违法。`validateAccountProfile` 在构造上拒绝 `kind: bot` / `proxyPool` / `generatedIdentity` |
| **C 批量注册邮箱 + EDM** | 一半 | `edm/*`：CAN-SPAM / GDPR / Gmail-Yahoo 2024 批量发件要求的静态检查、同意制受众过滤（购买/爬取名单在数据层就表达不出来）、抑制名单、域名预热上限、投诉率熔断、可续跑发送循环 | **批量注册消费者邮箱不做**：`compliance.js` 直接把 gmail/outlook/qq/163 等 30 个消费者域拒作发件身份；批量注册本身是邮箱服务商 ToS 违规且这些域没法给你配 SPF/DKIM/DMARC |
| **D 社群产品里发帖与营销** | ✅ 做，但有纪律 | `community/*`：贡献账本（≥7:1）、subreddit 版规判读（`about/rules`）、明示身份模板（中英）、冷却期、Discord 频道 slowmode | **冷 DM 群发不做**（`community.UNSUPPORTED`）：既是 spam 也是最大的 prompt injection 面；入站 DM 的分类与草拟回复由既有 `community` agent 做，人来点发送 |

---

## 3. 平台矩阵（撰写时公开信息，实施前逐条复核官方文档）

| 平台 | 模式 | 授权 | 文案上限 | 媒体 | 读自己指标 | 日上限（能力层默认） | 需平台审核 | 端点已实测 |
|---|---|---|---|---|---|---|---|---|
| X | api_direct | OAuth2 PKCE | 280，支持线程 | 图 ≤4 / 视频 ≤140s（v2 分片上传） | 付费档才有 | 50 | 否 | ✅ |
| Instagram | api_direct | Meta Graph（需 Business + FB Page） | 2200，≤30 话题 | 图 / Reels，**必须有媒体** | ✅ Insights | 25 | 否 | ✅ |
| Discord | api_direct | Bot token 或 Webhook | 2000（embed 4096） | 附件 ≤10 | Bot 能读反应 | 200 | 否 | ✅ |
| Reddit | api_direct | OAuth2 | 标题 300 / 正文 40000 | 图 / 视频 / 链接 | ✅ | 3（社群纪律另计） | 否 | ✅ |
| YouTube | api_direct | Google OAuth | 标题 100 / 描述 5000 | 视频 only | ✅ | 6（配额 10000 单位 / 上传 1600） | 否 | ✅ |
| TikTok | api_direct | OAuth2 PKCE | 2200 | 视频 / 图文 | 需 `video.list` | 15 | **是**（未过审只能 SELF_ONLY 草稿） | ✅ |
| 小红书 | manual_package | — | 标题 20 / 正文 1000 / ≤10 话题 | 图 ≤18（3:4）/ 视频 | 无 | 3 | — | — |
| 微信视频号 | manual_package | — | 1000 | 视频 + 封面 1080×1260 | 无 | 3 | — | — |
| 微信公众号 | **api_draft** | AppID/AppSecret + IP 白名单 | 标题 64 / 摘要 120 / 作者 8 | 封面 2.35:1，正文图必须先上传 | 日报（datacube） | 订阅号 1 次/天 | 认证号才能 freepublish | ✅ |
| B 站 | api_direct | 开放平台 OAuth + HMAC-SHA256 请求签名 | 标题 80 / 简介 2000 / ≤10 标签 | 视频 + 封面必填 | scope 限定 | 3 | **是** | ❌ 按文档实现 |
| 抖音 | api_direct | 开放平台 OAuth（`client_key`） | 1000 | 视频 / 图文 | `video.data` scope | 5 | **是**（企业号） | ❌ 按文档实现 |
| 快手 | api_direct | 开放平台 OAuth（`app_id`） | 1000 | 视频 | `user_video_info` scope | 5 | **是** | ❌ 按文档实现 |

`endpointsVerified: false` 的三家（B 站 / 抖音 / 快手）：请求形状按公开文档实现并有请求整形测试，但**没有拿真实过审应用打过**。签发凭据之前先用一个测试号跑通一次，把 `capabilities.js` 里的标记翻成 `true` 时附上实测记录。

---

## 4. 模块与合同

```
packages/social-ops/
├─ index.js            createSocialOps(deps) · manifest() · 静态导出
├─ capabilities.js     12 平台矩阵（PLATFORMS / resolvePlatformId / platformsByMode）
├─ refusals.js         REFUSALS：拒绝什么、为什么、用什么替代
├─ result.js           ok/fail · httpFailure（429/5xx 可重试，401/403 auth，其它 4xx 客户端）· resolveDeps（fetch 注入）
├─ oauth.js            buildAuthorizeUrl / exchangeCode / refreshAccessToken（8 个 OAuth 平台，纯函数）
├─ adapt.js            adaptForPlatform：上限、线程拆分、话题、粘贴包、公众号 HTML
├─ connectors/         每平台一个：validate(payload) · publish(creds, payload, deps) · fetchMetrics(creds, id, deps)
├─ pipeline/           runContentPipeline(input, {llm, imageGen, gate}) · createLexiconGate
├─ edm/                compliance · audience · suppression · batch(warmup/breaker) · campaign(runEdmCampaign)
├─ community/          playbook(ledger/rules/disclosure) · promoteOnReddit · contributeOnReddit · postToDiscordChannel
└─ matrix/policy.js    validateAccountProfile · dailyCapFor · planStagger
```

**connector 合同**（`connectors/index.js` 的 `assertConnectorContract` 守着）：

```js
validate(payload)                            // string[]，同步、无网络
publish(credentials, payload, deps)          // { success, externalId, url, status, retryable, kind, ... }
fetchMetrics(credentials, externalId, deps)  // { available, metrics?: {impressions, views, likes, comments, shares, saves, raw}, reason? }
```

`status` 取值：`published` · `draft`（平台草稿箱，人来点）· `scheduled`（平台侧定时）· `pending_review`（平台审核中）· `packaged`（manual_package）。`requiresHumanFinalStep: true` 表示宿主状态机应停在「已推到平台，等人」而不是当失败。

**deps 注入**：`{ fetch, logger, now, sleep, userAgent }`。服务端传 `proxy-fetch`（走 HTTPS_PROXY），测试传脚本化 fetch，Cuddler 传全局 fetch。

---

## 5. 服务端接线

- `server/publish/oauth.js`：`publishTwitter / publishInstagram / publishYouTube / publishTikTok / publishReddit` 现在是委托 stub（`legacyResult()` 把 `externalId` 映回 `platform_post_id`）。`publishDirect` 的分派、`platform_connections` 的加密与 OAuth 回调**没动**——那是宿主职责，留在服务端。
- `Dockerfile` 新增 `COPY packages/ packages/`（在 `COPY server/` 之前）——漏掉它，镜像里第一次发帖就 `MODULE_NOT_FOUND`。
- `publisher` agent、`scheduled-publish`、`/api/publish/direct/:platform` 三个调用方零改动。

---

## 6. 用法示例

```js
const so = require('../packages/social-ops');
const ops = so.createSocialOps({ fetch: require('../server/proxy-fetch') });

// 一条内容 → 三个平台两种语言（LLM 注入，词表闸拦 companion 一类高危词）
const out = await ops.pipeline.runContentPipeline({
  brief: { topic: 'EP03 上线', cta: 'Watch now', link: 'https://cuddler.ai/s/abc?utm_content=p1', brandVoice: 'warm' },
  platforms: ['x', 'youtube', 'xiaohongshu'],
  locales: ['en', 'zh'],
  assets: { videoUrl: 'https://cdn/ep03.mp4' },
  lexicon: { banned: ['companion', '伴侣'] },
}, { llm: { complete: myLlm }, imageGen: myNanoBanana });
out.variants.filter(v => !v.gate.ok);   // 拦下的，带命中词，不会静默丢

// 发（凭据由宿主解密后传入）
await ops.publish('x', { accessToken }, { text: out.variants[0].text, threadParts: out.variants[0].threadParts });

// 小红书：拿到粘贴包 + 确定性 package id，人发完把链接贴回
const pkg = await ops.publish('xiaohongshu', null, { title, text, mediaUrls });

// EDM：同意制名单 → 合规检查 → 预热上限 + 熔断 → 注入 send
const { eligible } = ops.edm.filterAudience(list, { suppression });
const check = ops.edm.checkCampaignCompliance({ from, subject, html, unsubscribeUrl, physicalAddress, listUnsubscribe, oneClickUnsubscribe: true, auth });
if (check.ok) await ops.edm.runEdmCampaign({ recipients: eligible, render, send: resendSend, dailyCap: ops.edm.warmupCap(day), breaker });
```

---

## 7. 测试

`server/__tests__/social-ops-*.test.js`（`npm test` 自动纳入）：

| 文件 | 覆盖 |
|---|---|
| `social-ops-capabilities` | 12 平台矩阵不变量、manual/draft 模式归属、未实测标记、别名、connector 合同、manifest 可序列化、**全包无 `process.env` 读取** |
| `social-ops-adapt` | X 线程拆分不丢内容、小红书 20 字标题与 18 图、公众号 64/120 与 HTML 转义、YouTube 视频 only、IG 30 话题、B 站封面、Discord 2000 |
| `social-ops-connectors` | 12 个 connector 缺凭据零网络失败、每平台请求整形（脚本化 fetch）、429/403 分类、IG Reels 轮询、YouTube 定时强制 private、TikTok SELF_ONLY 草稿、Reddit RATELIMIT 可重试、公众号 40164 提示、B 站签名头、OAuth URL 与换码 |
| `social-ops-pipeline` | plan→write→adapt 全链、词表闸拦截 + 一次重写 + 残留上报、imageGen 补图、输入校验 |
| `social-ops-edm` | 合规地板正反例、退订头、抑制名单事件映射、同意制过滤 11 种排除理由、预热/熔断、发送循环的限速/抑制/日上限/预算/游标 |
| `social-ops-community-matrix` | 7:1 账本 + 冷却、版规判读、明示身份幂等、拒绝后不调 submit、允许后带 disclosure 发并记账、账号形状拒绝 bot/代理池、错峰排期 |

---

## 8. 下一步（按优先级）

1. **Cuddler 侧接入**（姊妹文档）：`SocialAccount` 加密列 + 后台 OAuth 连接 + `POST /api/admin/social-ops/publish` 走本层。
2. **B 站 / 抖音 / 快手实测**：各拿一个测试号跑通一次，翻 `endpointsVerified`。
3. **服务端 OAuth 也委托**：`server/publish/oauth.js` 的 `buildAuthorizeUrl / exchangeCodeForToken` 仍是自己的一份（读 env）；下一步改成调 `packages/social-ops/oauth.js` 并把 env 读取留在服务端。
4. **community agent 接 playbook**：现有 `agents-v2/community.js` 的 fetch/classify/draft 保持，`promoteOnReddit` 作为它的第四个 action 暴露给 Conductor。
5. **发布到 npm**：`@influencex/social-ops` 0.1.0；发布前把 `endpointsVerified:false` 的三家在 README 里再标一次。
