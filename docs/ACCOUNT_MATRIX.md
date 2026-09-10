# 社媒账号矩阵设计

> 落地 `packages/social-ops/matrix/policy.js` 定义的**自有、披露**账号矩阵：每个号都属于真实主体、由真人持有、通过平台 OAuth 同意页授权连接。
> 与 Cuddler 侧的 `docs/gtm_social_accounts_setup.md`（2026-09-07，owner 拍板）是同一套东西的两半——那份是**逐字注册规格**，这份是**矩阵结构与治理**。
> 最后更新：2026-09-10。

---

## 1. 为什么是几十个而不是几千个

`packages/social-ops/refusals.js` 的 `bot_account_farms` 条目已经裁决过这件事，理由有三层，第三层最容易被低估：

1. **平台侧**：协同虚假行为在 X / Meta / Reddit / Discord / TikTok / YouTube / 小红书 / 抖音 / 快手 / B 站全部违规
2. **法律侧**：在 CN 属流量造假（网信办《网络信息内容生态治理规定》第二十四条），在 US/EU 属欺骗性背书（FTC 16 CFR Part 465）
3. **工程侧**：**封号会级联** —— 共享 IP、设备指纹、支付方式或找回邮箱的账号会被一起打击。官方号和机器号共用任何一样东西，官方号就在射程内

第 3 条决定了架构：**官方号的注册邮箱、找回地址、出口 IP，必须与任何批量资产完全隔离**。本文的 `social@gogameclaw.com` 与专用 VM 就是这个隔离的实现。

另有一条纯效果判断：新注册、零粉、无历史的账号在所有平台都被重度冷启动降权。**几百个新号同发一条内容的总曝光，通常低于一个真实腰部创作者的一条合作内容**。矩阵的价值不在数量，在每个号背后有真实受众。

---

## 2. 矩阵结构

| 层 | 数量级 | 说明 |
|---|---|---|
| **品牌主号** | 每平台 1 个 | `@cuddler_ai`（X）、`@cuddlerai`（YouTube）等 |
| **语区分号** | 重点语区 2–4 个 | Cuddler 支持 10 语种，但**不要一次开 10 个**——没有对应语言的运营人力就是空号 |
| **员工个人号** | 自愿，需披露 | 个人号转发公司内容必须在 bio 或帖内注明雇佣关系（FTC 要求） |
| **创作者合作号** | 走 KOL 流程 | 不属于矩阵，属于 outreach；见 [CAMPAIGN_UMBRELLA_CRASHER.md](./CAMPAIGN_UMBRELLA_CRASHER.md) §4 |

合计**约 25–40 个**，全部登记在册。

---

## 3. 注册与找回：统一走 `social@gogameclaw.com`

所有官方号的**注册邮箱**与**找回地址**指向 `social@gogameclaw.com`（已建，见 [GOGAMECLAW_DOMAIN_MAIL.md](./GOGAMECLAW_DOMAIN_MAIL.md) §3）。

**为什么不用个人邮箱**：个人邮箱的持有人离职、换手机、丢设备，账号就废了。Cuddler 那份 gtm 文档已经写了"账号邮箱用公司域名邮箱，不要个人邮箱"，这里给出具体地址。

**为什么不是一号一邮箱**：一号一邮箱是机器号的做法，它的目的是让平台无法把这些号关联起来。官方矩阵的目标恰恰相反——**我们希望平台知道这些号是同一个主体的**，这样它们互相之间的转发和引用不会被判成操纵。

⚠️ **前置**：MX 已切飞书且 SPF 为 `-all`，`social@` 建好之前 gogameclaw.com 收不到任何信。注册前先自测一封。

---

## 4. 持有人登记

每个号建一条记录，缺一不可：

| 字段 | 说明 |
|---|---|
| 平台 + handle | |
| 主体 | 品牌 / 语区 / 员工个人 |
| **持有人** | 真人姓名，负责 2FA 与日常发布 |
| 注册邮箱 | 统一 `social@gogameclaw.com` |
| **2FA 方式** | TOTP 优先；短信兜底。**必须开** |
| 恢复码存放位置 | 密码管理器的团队保险库，**不落磁盘、不进 git** |
| 授权状态 | 是否已通过 OAuth 连接到 social-ops |
| 离职回收 | 持有人变更时的交接责任人 |

**凭据不进代码库、不进 Secret Manager 的明文字段、不经过 agent**。social-ops 层拿到的只有 OAuth token，拿不到密码——这是 `refusals.js` 里 `headless_browser_login` 那条的直接推论。

---

## 5. 网络前置：注册用的干净出口

国内网络打不开 X / IG / YouTube / Discord / Reddit。已开一台新加坡 VM 供**人工操作**：

| 项 | 值 |
|---|---|
| 实例 | `cuddler-social-desktop` |
| 位置 | `asia-southeast1-b`（新加坡） |
| 出口 IP | `35.240.215.44` |
| 项目 | `cuddler-500909` |
| 环境 | XFCE + Chrome 153 + Chrome Remote Desktop + Noto CJK |
| 服务账号 | **无** —— 浏览器机器不带云凭据 |

接入：https://remotedesktop.google.com/headless 拿 code → `gcloud compute ssh cuddler-social-desktop --project=cuddler-500909 --zone=asia-southeast1-b` → 粘贴执行 → 设 PIN。**授权绑操作者自己的 Google 账号。**

⚠️ **这是数据中心 IP**，不是住宅 IP。它解决的是**可达性**，不是"看起来像家庭用户"。注册时平台大概率会要手机验证——真人注册真实品牌号，收码通过即可。

⚠️ **用完停机**：e2-standard-4 在新加坡约 $0.13/小时，常开约 $97/月。
```bash
gcloud compute instances stop cuddler-social-desktop --project=cuddler-500909 --zone=asia-southeast1-b
```

---

## 6. 平台特定门槛

细节见 [PLATFORM_PUBLISHING_CONSTRAINTS.md](./PLATFORM_PUBLISHING_CONSTRAINTS.md)，与建号直接相关的：

| 平台 | 建号阶段要注意 |
|---|---|
| **Instagram** | 必须建成 **Business/Creator** 账号并关联 FB 页面，否则 Graph API 发不了 |
| **YouTube** | 频道级 **Made for kids 显式选「否」**（COPPA 法律字段，选错会关闭评论与个性化推荐） |
| **TikTok** | 建号即可，但 API 发布需过 audit；T0 走人工 |
| **Reddit** | **立刻建号开始计时** —— 多数 sub 要求账号 ≥30 天 + karma 门槛。T0 不排 Reddit |
| **X** | 2FA 必开；Protected posts 必关（否则引用与短链全废） |

---

## 7. 待办

- [ ] owner 在 VM 上完成 X / YouTube 建号（逐字规格见 Cuddler `docs/gtm_social_accounts_setup.md` §2/§3）
- [ ] 建号当天回填 `marketing/x-launch-plan.html` 的 **15 处** `@cuddlerAI` 占位
- [ ] Reddit 账号即刻注册开始养 30 天
- [ ] Instagram 建成 Business 账号 + 关联 FB 页
- [ ] 建立持有人登记表（§4 字段）
- [ ] 各号通过 OAuth 连接到 social-ops
