# gogameclaw.com — 域名安全与邮件体系

> 本文合并了原计划的 ①域名安全 与 ②飞书邮箱 两份——它们其实是同一个系统：邮件认证（SPF/DKIM/DMARC）既是"邮箱能不能发信"，也是"域名安全权重"唯一可测量的部分。
> 最后更新：2026-09-10。实测数据来自 Cloudflare API（zone `0f283f6b1638d845f6bdb555f03d3292`）与飞书 OpenAPI（app `cli_a94eb8811578dcd4`）。

---

## 0. 一眼看清

| 项 | 状态 |
|---|---|
| CF 计划 | **Enterprise**，active |
| Zone ID | `0f283f6b1638d845f6bdb555f03d3292` |
| Apex | 4×A + 4×AAAA，**proxied**，指向 Google `216.239.3x.21` 一组 |
| MX | **飞书**（mx1/mx2/mx3.feishu.cn，prio 1/5/10） |
| SPF | ✅ `v=spf1 +include:_netblocks.m.feishu.cn -all`（硬失败） |
| DMARC | ✅ `p=none`（2026-09-10 新增，监控期） |
| **DKIM** | ✅ selector `feishu2609101452`（2026-09-10 发布，RSA） |
| 邮箱 | ✅ 10 个角色公共邮箱已建 |

---

## 1. 一次不可逆的切换已经发生

2026-09-10，MX 从 Namecheap 转发（`eforward1-5.registrar-servers.com`）切到了飞书。

**后果要记住**：切换前 gogameclaw.com 靠 Namecheap 转发收信，任何地址都能收；切换后**只有飞书里真实存在的邮箱才能收信**，其余一律退信。这就是本文第 3 节那 10 个邮箱必须先建的原因——在它们建好之前，这个域处于"完全收不到信"的状态。

SPF 同时从 `~all`（软失败）收紧到了 `-all`（硬失败）。这是对的，但意味着**任何不经飞书的发信路径会被直接拒收**——包括 Resend。如果以后要用 Resend 从 `market@gogameclaw.com` 发营销邮件，必须先把 Resend 的 include 加回 SPF，否则全量进垃圾箱。

---

## 2. DKIM

**已发布**（2026-09-10）：

```
feishu2609101452._domainkey.gogameclaw.com  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0..."
```

公网解析已验证（1.1.1.1 与 8.8.8.8 均返回 415 字节）。

⚠️ **selector 是飞书按时间戳生成的**（`feishu` + `YYMMDDHHMM`），不是固定值。猜不出来——要查现有 selector 直接列 zone 里的 `_domainkey` 记录，别去试常见名：

```bash
CF=$(gcloud secrets versions access latest --secret=CLOUDFLARE_API_TOKEN --project=cuddler-500909)
curl -s -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/zones/0f283f6b1638d845f6bdb555f03d3292/dns_records?per_page=100" \
  | grep -o '[a-z0-9]*\._domainkey[^"]*'
```

⚠️ **其余域仍然没有 DKIM**：`luddi.ai` / `doudou.ai` / `huoban.ai` 三个同样在用飞书邮箱的域实测查无记录。gogameclaw.com 现在是这个租户里**唯一**邮件认证完整的域。那三个域一旦要发正式邮件，会遇到同样的问题。

---

## 3. 已建的角色邮箱

命名遵循**这个租户自己的房规**——实测现有 63 个邮箱（35 公共 + 28 邮箱组）里只有 1 个是自然人名（`jasperlau@doudou.ai`），其余全部是角色/用途命名。

| 邮箱 | 用途 |
|---|---|
| `info@` | 对外总入口 |
| `support@` | 用户支持 |
| `market@` | 营销发信（与 `market@luddi.ai` / `market@doudou.ai` 同名同义） |
| `business@` | 商务合作 |
| `press@` | 媒体公关 |
| `jobs@` | 招聘 |
| `tech@` | 技术公共 |
| `noreply@` | 系统发信 |
| `social@` | **社媒账号注册与找回** |
| `dmarc@` | DMARC 聚合报告收件 |

`social@gogameclaw.com` 是专门为账号矩阵留的：所有官方社媒号的注册邮箱与找回地址都指到这里，而不是任何个人邮箱。理由见 [ACCOUNT_MATRIX.md](./ACCOUNT_MATRIX.md) §3。

### 3.1 权限现状

app `cli_a94eb8811578dcd4` 当前拿到的 scope：

| scope | 状态 | 能做什么 |
|---|---|---|
| `mail:mailgroup` | ✅ | 读写邮箱组 |
| `mail:public_mailbox` | ✅ | 读写公共邮箱 ← 上表就是用它建的 |
| `mail:user_mailbox` | ❌ | 管理个人邮箱、别名 |
| `contact:*` | ❌ | 建人员账号 |

**要建真人邮箱得再开后两组**。但在给出真实花名册之前不建议开——公共邮箱不绑人头，个人邮箱绑，两者的治理成本不一样。

---

## 4. DMARC 推进路线

现在的记录（TTL 3600）：

```
_dmarc.gogameclaw.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@gogameclaw.com;
                              ruf=mailto:dmarc@gogameclaw.com; fo=1;
                              adkim=r; aspf=r; pct=100"
```

`p=none` 是**监控期**，不拦任何信。推进节奏：

| 阶段 | 条件 | 动作 |
|---|---|---|
| 现在 | — | `p=none`，收 2 周聚合报告 |
| 第 3 周 | ~~DKIM 已发布~~ ✅ **且** 报告里无合法来源失败 | `p=quarantine; pct=25` |
| 第 5 周 | quarantine 无误伤 | `pct=100` |
| 第 7 周 | 稳定 | `p=reject` |

**不要跳步**。`p=reject` 配错的代价是所有对外邮件静默消失，而且你不会收到任何报错——这正是 DMARC 设计成分级的原因。

---

## 5. 待办

- [x] ~~飞书后台开 DKIM~~ —— 已完成 2026-09-10，selector `feishu2609101452`
- [ ] 两周后（**2026-09-24 起**）看 `dmarc@gogameclaw.com` 的聚合报告，决定是否升 `p=quarantine`（DKIM 已就位，这一步不再有前置阻塞）
- [ ] 考虑给 `luddi.ai` / `doudou.ai` / `huoban.ai` 补 DKIM（同一租户，同样缺）
- [ ] 若要用 Resend 发营销邮件：先把 Resend include 加进 SPF，否则 `-all` 会全拒
- [ ] 真人邮箱：给花名册 + 开 `mail:user_mailbox` 与 `contact:*` scope

---

## 6. 复现命令

```bash
# 看 DNS 现状
CF=$(gcloud secrets versions access latest --secret=CLOUDFLARE_API_TOKEN --project=cuddler-500909)
curl -s -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/zones/0f283f6b1638d845f6bdb555f03d3292/dns_records?per_page=100"

# 飞书 token
ID=$(gcloud secrets versions access latest --secret=FEISHU_APP_ID --project=gameclaw-492005)
SEC=$(gcloud secrets versions access latest --secret=FEISHU_APP_SECRET --project=gameclaw-492005)
curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" -d "{\"app_id\":\"$ID\",\"app_secret\":\"$SEC\"}"
```

凭据都在 Secret Manager（`gameclaw-492005`：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`；`cuddler-500909`：`CLOUDFLARE_API_TOKEN`）。**AppSecret 曾在明文对话里出现过，建议轮换后加新 version。**
