# Authentication & Secrets

How the app authenticates users in the browser, and how API keys / credentials flow from your local `.env` to a Cloud Run deployment.

**Audience:** new contributors trying to make sense of why login uses both `localStorage` and a DB-backed session, and why `.env` is still needed when GCP Secret Manager exists.

---

## 1. User authentication (browser ↔ server)

The session model is **DB-backed opaque tokens transported in `Authorization: Bearer …` headers**. No JWTs, no signed cookies.

### 1.1 Server side — [server/auth.js](../server/auth.js)

```
POST /api/auth/login
  ├─ verify password (bcryptjs)
  ├─ createSession(userId)
  │    INSERT INTO sessions (id, user_id, expires_at)  — id is 64-char hex
  └─ respond { token: <hex>, user: {...}, expiresAt }

authMiddleware (every protected request)
  ├─ read req.headers.authorization → strip "Bearer "
  ├─ SELECT * FROM sessions WHERE id = ?
  │    if missing or expired → 401
  └─ req.user = <session row>;  next()

POST /api/auth/logout
  └─ DELETE FROM sessions WHERE id = ?    — token is dead immediately
```

**Important:** the comment on [auth.js:78](../server/auth.js#L78) says "or cookie", but the code only reads `Authorization`. There is no cookie path. `curl -c cookies.txt` will always 401; you must send `-H "Authorization: Bearer <token>"`.

### 1.2 Client side — [client/src/api/client.js](../client/src/api/client.js), [AuthContext.jsx](../client/src/AuthContext.jsx)

Token storage:

```js
localStorage.getItem('influencex_token')      // ← the auth token
localStorage.getItem('influencex_campaign')   // ← last selected campaign
```

Note the `influencex_` prefix — checking `localStorage.getItem('token')` will return null and confuse you.

Request flow:

```
api.request(path, opts)
  ├─ token = localStorage.getItem('influencex_token')
  ├─ headers.Authorization = `Bearer ${token}`   (if token present)
  └─ fetch(`/api${path}`, { headers, ... })
```

Bootstrap on page load (`AuthContext` `useEffect`):

```
1. If URL hash contains #sso_token=… (SSO callback) → save it, scrub URL.
2. Read influencex_token from localStorage.
3. If present → GET /api/auth/me to populate React user state.
4. If GET /me fails → setToken(null), redirect to login.
```

### 1.3 Workspace context, separately from auth

After login, the user picks a workspace (or the server falls back to their default). The current workspace id is **kept in React state** (`WorkspaceContext`) and sent on each request as `X-Workspace-Id: <uuid>`. It is **not** baked into the auth token. One token, many workspaces.

The selected campaign is the only workspace-related thing persisted in `localStorage` (`influencex_campaign`).

### 1.4 Trade-offs vs JWT

| | DB-backed session (current) | JWT |
|---|---|---|
| Logout invalidation | Immediate (`DELETE` row) | Need a revocation list / short TTL |
| Per-request cost | One `SELECT sessions` lookup | Just signature verify |
| Horizontal scaling | `sessions` table is shared state | Stateless |
| Key rotation | Not applicable | Need rotation procedure |

Current scale doesn't justify JWT; the DB lookup is sub-millisecond and revocation is cleaner. Revisit if `sessions` becomes a hotspot.

### 1.5 Cleanup

[auth.js:134](../server/auth.js#L134) exports `cleanupExpiredSessions()` — `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP`. Wire it into a scheduler tick if the table grows.

---

## 2. Secrets — `.env`, GCP Secret Manager, and the in-DB credentials vault

Three different things share the word "secret". They are **not** alternatives.

### 2.1 Three layers, one direction

```
              ┌──────────────────────────────────────────────┐
              │  .env  (local file, gitignored)              │
              │  YOUTUBE_API_KEY=…                            │
              │  RESEND_API_KEY=…                             │
              │  ANTHROPIC_API_KEY=…                          │
              │  MAILBOX_ENCRYPTION_KEY=…                     │
              └─────────────────┬────────────────────────────┘
                                │
            ┌───────────────────┼────────────────────┐
            │ local dev         │ deploy             │
            ▼                   ▼                    │
    dotenv loads at         setup-secrets.sh         │
    `node server/index.js`  reads .env line-by-line  │
            │                   │                    │
            │                   ▼                    │
            │           GCP Secret Manager           │
            │           (one secret per key)         │
            │                   │                    │
            │                   │ deploy.sh:111      │
            │                   ▼                    │
            │       Cloud Run --update-secrets       │
            │       mounts each as an env var        │
            ▼                   ▼                    │
        process.env.YOUTUBE_API_KEY ◀────────────────┘
                  │
                  ▼
       Server code (e.g. server/youtube-discovery.js):
       const KEY = process.env.YOUTUBE_API_KEY;
```

The server **never knows** whether a value came from `.env` or from Secret Manager — it always reads `process.env`. Secret Manager exists so the **GCP service config** doesn't carry plaintext API keys, not so the **runtime** is different.

### 2.2 What lives where

| File / thing | Role | Required for |
|---|---|---|
| [`.env.example`](../.env.example) | Template, checked in | Onboarding |
| `.env` | Your real values, **gitignored** | Local dev. Also the source for `setup-secrets.sh`. |
| [`setup-secrets.sh`](../setup-secrets.sh) | One-shot uploader from `.env` → GCP Secret Manager | Initial deploy / when keys rotate |
| [`deploy.sh`](../deploy.sh) | `gcloud run deploy ... --update-secrets ...` | Every Cloud Run release |
| GCP Secret Manager | Secure store for production values | Cloud Run only |
| `process.env.X` | What the code reads | Always |

You always need `.env` locally. You don't need it in the deployed container.

### 2.3 The `setup-secrets.sh` allowlist

Only **truly sensitive values** go to Secret Manager. The list is hard-coded in [setup-secrets.sh:38](../setup-secrets.sh#L38) (`SECRET_NAMES=(...)`). Things deliberately **not** in it:

- `*_CLIENT_ID` (OAuth client IDs are sent to the browser anyway — not secrets)
- Ports, feature flags, model names, region — those go in `--update-env-vars` in `deploy.sh`

Keep the list tight. A flag-per-toggle in Secret Manager is sprawl.

### 2.4 The other "secrets": [server/secrets.js](../server/secrets.js)

This module is unrelated to GCP. It encrypts **user-provided credentials** (Gmail OAuth refresh tokens, SMTP passwords, Resend API keys per workspace) before storing them in the `mailbox_accounts` table.

```
AES-256-GCM, random 12-byte IV, format:  aead:v1:<iv_b64>:<tag_b64>:<ct_b64>
Key source:  process.env.MAILBOX_ENCRYPTION_KEY (32 bytes, base64-encoded)
```

If `MAILBOX_ENCRYPTION_KEY` is unset, a deterministic dev key is derived from the hostname and a loud warning is logged. **Don't deploy without setting it.** Rows encrypted on machine A won't decrypt on machine B.

Generate one with:

```
openssl rand -base64 32
```

Rotation: see [`server/scripts/rotate-mailbox-key.js`](../server/scripts/rotate-mailbox-key.js) (re-encrypts every row under the new key).

### 2.5 Why this matters when something breaks

| Symptom | Most likely cause |
|---|---|
| `discovery_jobs.status='error'` with `YOUTUBE_API_KEY not configured` | `.env` missing the key locally, or it never made it to Secret Manager |
| Email sends mark `status='sent'` but nothing arrives | No `RESEND_API_KEY` and no mailbox account → falls into the dev dry-run path ([email-jobs.js:104](../server/email-jobs.js#L104)) |
| `[secrets] using a dev-only derived key` warning at startup | `MAILBOX_ENCRYPTION_KEY` not set |
| Mailbox creds decrypt fine locally but `Bad auth tag` in production | A different `MAILBOX_ENCRYPTION_KEY` was used to encrypt vs decrypt — re-run `rotate-mailbox-key.js` or restore the old key |
| `curl -b cookie http://…/api/me` returns 401 | The server reads `Authorization`, not cookies. Use `-H "Authorization: Bearer …"` |
| `localStorage.token` is null in DevTools | The actual key is `influencex_token` |

---

## 3. Quick reference

**Local dev from a clean checkout:**

```bash
cp .env.example .env
# fill in at minimum: YOUTUBE_API_KEY, RESEND_API_KEY, HUNTER_API_KEY,
# ANTHROPIC_API_KEY (optional), MAILBOX_ENCRYPTION_KEY
openssl rand -base64 32   # paste into MAILBOX_ENCRYPTION_KEY=

npm install
npm test                  # 255 tests, no external deps required
npm run dev               # backend on :8080
cd client && npm run dev  # frontend on :5173, proxies /api → :8080
```

**Login over the API:**

```bash
TOKEN=$(curl -s http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@…","password":"…"}' | jq -r .token)

curl http://localhost:8080/api/auth/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-Id: <ws-uuid>"
```

**Deploy:**

```bash
./setup-secrets.sh        # uploads .env values to GCP Secret Manager (one-time / on rotation)
./deploy.sh               # gcloud run deploy with --update-secrets
```

That's the full picture. If something here goes stale, please update — this file is meant to be the one place new contributors check.
