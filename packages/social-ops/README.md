# @influencex/social-ops

The social operations **capability layer**: everything InfluenceX knows about
publishing to, measuring on, and behaving well in twelve social platforms —
packaged so a private host (one that actually holds the account credentials)
can run it in-process.

**It holds no credentials.** Every function takes them as arguments and never
reads `process.env`, a database, or a file. It never drives a browser or a
login form. Platform refusals come back as `{ success: false, error,
retryable }`, not exceptions.

```js
const so = require('@influencex/social-ops');
const ops = so.createSocialOps({ fetch });         // deps once

ops.manifest().platforms.map(p => `${p.id}:${p.publishMode}`);
// x:api_direct instagram:api_direct discord:api_direct reddit:api_direct
// youtube:api_direct tiktok:api_direct xiaohongshu:manual_package
// wechat_channels:manual_package wechat_mp:api_draft bilibili:api_direct
// douyin:api_direct kuaishou:api_direct

await ops.publish('x', { accessToken }, { text: 'hello', threadParts: ['…'] });
await ops.fetchMetrics('youtube', { accessToken }, videoId);

const pkg = await ops.publish('xiaohongshu', null, { title, text, mediaUrls });
// → { status: 'packaged', package: { title, body, hashtags, images, steps } }
```

| Module | What it gives the host |
|---|---|
| `capabilities` | The 11-platform matrix: mode, auth kind, limits, media rules, metrics readability, audit requirements, `endpointsVerified` |
| `connectors` | One contract (`validate` / `publish` / `fetchMetrics`) per platform |
| `oauth` | Pure authorize-URL / code-exchange / refresh helpers; the human opens the consent page |
| `adapt` | Deterministic per-platform shaping (limits, threads, hashtags, paste packages) |
| `pipeline` | brief → plan → copy → visual → adapt → vocabulary gate, with an injected LLM |
| `edm` | Compliance floor, consent-based audience filter, suppression, warm-up, complaint breaker, resumable campaign runner with an injected `send` |
| `community` | Contribution ledger (7:1), subreddit-rule assessment, disclosure, Discord slowmode |
| `matrix` | Owned-account matrix policy and stagger planner |
| `REFUSALS` | What this layer will not do, why, and what to use instead |

Full design: [`docs/SOCIAL_OPS_CAPABILITY_LAYER.md`](../../docs/SOCIAL_OPS_CAPABILITY_LAYER.md).
Tests: `server/__tests__/social-ops-*.test.js` (`npm test`).
