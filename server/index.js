require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const { query, queryOne, exec, transaction, initializeDatabase, usePostgres, getQueryStats, scoped } = require('./database');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware, registerUser, loginUser, destroySession, getSession } = require('./auth');
const authGoogle = require('./auth-google');
// Stripe billing intentionally removed — all features are free for invited users.
const { workspaceContext, listUserWorkspaces, getDefaultWorkspaceId } = require('./workspace-middleware');
const scraper = require('./scraper');
const mailAgent = require('./email');
const log = require('./logger');
const metrics = require('./metrics');
const bvSearch = require('./brand-voice-search');
const dataAgent = require('./content-metrics');
const discoveryAgent = require('./youtube-discovery');
const igDiscovery = require('./instagram-discovery');
const tiktokDiscovery = require('./tiktok-discovery');
const xDiscovery = require('./x-discovery');
const redditDiscovery = require('./reddit-discovery');
const apifyQuota = require('./apify-quota');
const youtubeQuota = require('./youtube-quota');
const { runPendingMigrations } = require('./migrations');
const emailTemplates = require('./email-templates');
const csvExport = require('./csv-export');
const rbac = require('./rbac');
const scheduler = require('./scheduler');
const scheduledPublish = require('./scheduled-publish');
const apifyWatchdog = require('./apify-watchdog');
const { rateLimit } = require('./rate-limit');
const { registerHealthRoutes } = require('./health');
const { getCampaignRoi } = require('./roi-dashboard');
const { buildOpenApiSpec, swaggerUiHtml } = require('./openapi');
const agentRuntime = require('./agent-runtime');
const conductor = require('./agent-runtime/conductor');
const agentsV2 = require('./agents-v2');
const llm = require('./llm');
const { createQueue } = require('./job-queue');
const emailJobs = require('./email-jobs');
const gmailOAuth = require('./mailbox-oauth-gmail');
const secrets = require('./secrets');
const abSig = require('./ab-significance');
const { defaultCache } = require('./cache');
const apify = require('./apify-client');

// Shared job queue for background work (scraping, enrichment, etc)
const jobQueue = createQueue({ concurrency: parseInt(process.env.QUEUE_CONCURRENCY) || 3 });

const app = express();
const PORT = process.env.PORT || 8080;
// Default to root path. Set BASE_PATH=/something for sub-path hosting.
const BASE_PATH = process.env.BASE_PATH ?? '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:8080', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // 1. No origin (curl, server-to-server, <img> subresources in some browsers)
    // 2. Non-production: allow all
    // 3. In ALLOWED_ORIGINS env list
    // 4. Same-origin: origin's host matches one of our serving hosts (apex/www)
    if (!origin || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    // Same-origin fallback — if the request Origin matches the Host we're serving on,
    // it's trivially allowed. Prevents misconfigured CORS_ORIGINS from breaking the app.
    try {
      const originHost = new URL(origin).host;
      if (ALLOWED_ORIGINS.some(allowed => {
        try { return new URL(allowed).host === originHost; } catch { return false; }
      })) {
        return callback(null, true);
      }
    } catch { /* malformed origin header */ }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// gzip/deflate response compression — significant bandwidth savings on JSON
// and HTML. Skips small bodies (<1kb) and already-compressed content types.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    // Don't compress CSV downloads — Content-Disposition: attachment files are
    // usually streamed to disk, compression adds CPU with little benefit
    if (req.path.endsWith('/export')) return false;
    return compression.filter(req, res);
  },
}));

// Resend webhook needs raw body for signature verification
const crypto = require('crypto');
const { Buffer } = require('buffer');
const RESEND_WEBHOOK_PATHS = new Set([
  `${BASE_PATH}/api/webhooks/resend/inbound`,
  `${BASE_PATH}/api/webhooks/resend/events`,
]);
app.use((req, res, next) => {
  if (RESEND_WEBHOOK_PATHS.has(req.path)) {
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; }
    })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// HTTP metrics middleware — records every request's method/route/status +
// latency histogram. Mounted before any business logic so 4xx auth rejects
// also show up. /metrics endpoint exposes the data (token-gated).
app.use(metrics.httpMetricsMiddleware);

app.get(`${BASE_PATH}/metrics`, metrics.metricsHandler({ jobQueue, llm }));

// Serve static frontend files with long-term caching for hashed assets.
// Vite emits content-hashed filenames in /assets (e.g. index-abc123.js),
// so we can safely cache them for a year. index.html is never cached.
app.use(BASE_PATH, express.static(path.join(__dirname, '..', 'client', 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      // Hashed bundle assets — immutable, cache forever
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      // HTML entry points — always revalidate
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      // Other files — short cache
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// Register health endpoints early (outside auth, rate limit, and BASE_PATH conventions)
registerHealthRoutes(app, BASE_PATH, { query, usePostgres, youtubeQuota });

// OpenAPI spec and Swagger UI
app.get(`${BASE_PATH}/api/openapi.json`, (req, res) => {
  res.json(buildOpenApiSpec(BASE_PATH));
});
app.get(`${BASE_PATH}/api/docs`, (req, res) => {
  res.type('html').send(swaggerUiHtml(`${BASE_PATH}/api/openapi.json`));
});

// Rate limiters — applied per-endpoint below
const authLimiter = rateLimit({ max: 10, windowMs: 60 * 1000, message: 'Too many auth attempts' });
const discoveryLimiter = rateLimit({ max: 5, windowMs: 60 * 1000, message: 'Discovery rate limit reached' });
const exportLimiter = rateLimit({ max: 10, windowMs: 60 * 1000, message: 'Too many exports' });
const sendEmailLimiter = rateLimit({ max: 20, windowMs: 60 * 1000, message: 'Email send rate limit reached' });
// Per-workspace cap on outbound sends. Uses a sliding 1-minute window; batch
// sends cost 1 "ticket" per contact enqueued. Tunable via env — default
// EMAIL_SEND_WORKSPACE_RPM=120 (i.e. 2 sends/sec sustained).
const EMAIL_SEND_WORKSPACE_RPM = parseInt(process.env.EMAIL_SEND_WORKSPACE_RPM) || 120;
const sendEmailWorkspaceLimiter = rateLimit({
  max: EMAIL_SEND_WORKSPACE_RPM,
  windowMs: 60 * 1000,
  keyFn: (req) => `ws:${req.workspace?.id || 'anon'}`,
  message: `Workspace email send rate limit reached (${EMAIL_SEND_WORKSPACE_RPM}/min). Batch operations will be rejected — try again shortly.`,
});

// ==================== Auth API ====================

// Public /api/auth/register without an invite code is intentionally removed —
// the platform is invite-only. Two valid signup paths exist:
//   1) POST /api/auth/register-with-code  — uses an admin-generated invite code
//   2) POST /api/invitations/:token/accept — uses a per-email invitation link
// The 410 Gone status makes it explicit to any old client code (or probe)
// that the legacy endpoint is dead.
app.post(`${BASE_PATH}/api/auth/register`, (req, res) => {
  res.status(410).json({
    error: 'Public registration is disabled. Use an invite code at /signup or ask a workspace admin for an invite link.',
    code: 'REGISTRATION_DISABLED',
  });
});

app.post(`${BASE_PATH}/api/auth/login`, authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const result = await loginUser(email, password);
    if (result.error) return res.status(401).json({ error: result.error });

    // Safety net: if the user has zero workspaces (e.g. orphaned account),
    // auto-create one. This prevents the "no workspace" limbo where every
    // /api/* call fails with `Workspace context required`.
    await ensureUserHasWorkspace(result.user.id, result.user.name || result.user.email);

    // Enrich with workspace info so the client can populate the switcher
    // immediately and the session has a default workspace to scope requests.
    const workspaces = await listUserWorkspaces(result.user.id);
    const currentWorkspaceId = workspaces[0]?.id || null;

    res.json({ ...result, workspaces, currentWorkspaceId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Forgot password / reset ====================
//
// Two-endpoint flow. /forgot-password creates a one-time token, hashes it
// (sha256) before storing, emails the plain token to the user. /reset-password
// looks up by hash, verifies expiry + unused, updates password_hash.
//
// Privacy: /forgot-password ALWAYS returns 200 even if the email isn't
// registered, so the endpoint can't be used to enumerate accounts.
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

app.post(`${BASE_PATH}/api/auth/forgot-password`, authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await queryOne('SELECT id, email, name FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    // Whether the user exists or not, return 200 — see comment above.
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

    await exec(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), user.id, tokenHash, expiresAt]
    );

    // Build reset link. Use the request's origin if available; fall back to
    // OAUTH_CALLBACK_BASE which we already maintain for SSO redirects.
    const origin = req.headers.origin || process.env.OAUTH_CALLBACK_BASE || `https://${req.headers.host}`;
    const link = `${origin}${BASE_PATH}/#/reset-password?token=${encodeURIComponent(token)}`;

    // Best-effort email. If it fails we still return ok to the client; the
    // user can retry. We log failures so ops can investigate.
    try {
      await mailAgent.sendEmail({
        to: user.email,
        subject: 'Reset your InfluenceX password',
        body: [
          `Hi ${user.name || ''},`,
          '',
          'You (or someone) asked to reset your InfluenceX password.',
          `Click the link below within ${Math.round(PASSWORD_RESET_TTL_MS / 60000)} minutes to set a new one:`,
          '',
          link,
          '',
          "If you didn't request this, you can safely ignore this email.",
          '',
          '— InfluenceX',
        ].join('\n'),
        fromName: 'InfluenceX',
      });
    } catch (e) {
      console.warn('[forgot-password] email send failed:', e.message);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/auth/reset-password`, authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const tokenHash = hashResetToken(token);
    const row = await queryOne(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
      [tokenHash]
    );
    if (!row) return res.status(404).json({ error: 'Invalid or expired token', code: 'TOKEN_NOT_FOUND' });
    if (row.used_at) return res.status(410).json({ error: 'Token already used', code: 'TOKEN_USED' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });

    const bcrypt = require('bcryptjs');
    const newHash = bcrypt.hashSync(password, 10);
    await exec('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, row.user_id]);
    await exec('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/auth/logout`, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) await destroySession(token);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get(`${BASE_PATH}/api/auth/me`, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await getSession(token);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    // Safety net for orphaned sessions whose workspace was deleted.
    await ensureUserHasWorkspace(user.id, user.name || user.email);
    const workspaces = await listUserWorkspaces(user.id);
    const currentWorkspaceId = workspaces[0]?.id || null;
    res.json({ ...user, workspaces, currentWorkspaceId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google SSO — initiate flow
app.get(`${BASE_PATH}/api/auth/google/init`, (req, res) => {
  try {
    if (!authGoogle.isConfigured()) return res.status(501).json({ error: 'Google SSO not configured on this deployment' });
    const { url } = authGoogle.buildAuthorizeUrl({ returnTo: req.query.returnTo });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google SSO — callback (browser redirect target). On success, creates a
// session and redirects to the SPA with `#token=...` so the client can
// persist it without leaking the token via Referer headers.
app.get(`${BASE_PATH}/api/auth/google/callback`, async (req, res) => {
  try {
    const { code, state, error: gErr } = req.query;
    if (gErr) return res.redirect(`${BASE_PATH}/auth?sso_error=${encodeURIComponent(gErr)}`);
    if (!code || !state) return res.redirect(`${BASE_PATH}/auth?sso_error=missing_code_or_state`);
    const stateEntry = authGoogle.consumeState(state);
    if (!stateEntry) return res.redirect(`${BASE_PATH}/auth?sso_error=invalid_state`);
    const profile = await authGoogle.exchangeCodeForIdentity(code);
    const userId = await authGoogle.upsertUserFromGoogle(profile);
    const { createSession } = require('./auth');
    const session = await createSession(userId);
    // Return to app with token in URL fragment (never leaves the browser).
    const returnTo = stateEntry.returnTo || '/';
    const safeReturn = returnTo.startsWith('/') ? returnTo : '/';
    res.redirect(`${BASE_PATH}${safeReturn}#sso_token=${encodeURIComponent(session.token)}`);
  } catch (e) {
    console.error('[google sso callback]', e);
    res.redirect(`${BASE_PATH}/auth?sso_error=${encodeURIComponent(e.message.slice(0, 80))}`);
  }
});

app.get(`${BASE_PATH}/api/auth/google/status`, (req, res) => {
  res.json({ configured: authGoogle.isConfigured() });
});

// Stripe billing routes removed. Platform is invite-only and free; plan
// field on workspaces is preserved for future use but has no functional effect.

// List workspaces the current user is a member of (for switcher UI)
app.get(`${BASE_PATH}/api/auth/workspaces`, authMiddleware, async (req, res) => {
  try {
    const workspaces = await listUserWorkspaces(req.user.id);
    res.json({ workspaces });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Workspace management ====================

// Create a new workspace (any authenticated user can)
app.post(`${BASE_PATH}/api/workspaces`, authMiddleware, async (req, res) => {
  try {
    const { name, plan } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }
    const id = uuidv4();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + id.slice(0, 6);
    await exec(
      'INSERT INTO workspaces (id, name, slug, owner_user_id, plan) VALUES (?, ?, ?, ?, ?)',
      [id, name.trim(), slug, req.user.id, plan || 'starter']
    );
    await exec(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [id, req.user.id, 'admin']
    );
    res.json({ id, name, slug, owner_user_id: req.user.id, role: 'admin', plan: plan || 'starter' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update workspace (admin of that workspace only)
app.patch(`${BASE_PATH}/api/workspaces/:id`, authMiddleware, async (req, res) => {
  try {
    const membership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    if (membership.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit workspace' });
    const { name, plan } = req.body;
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (plan !== undefined) { updates.push('plan = ?'); params.push(plan); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await exec(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Partial-update workspace settings JSON (admin of the workspace only).
// Body: any subset of keys to merge into workspaces.settings. Unknown keys
// are preserved on the server side — callers don't need to send the full blob.
app.patch(`${BASE_PATH}/api/workspaces/:id/settings`, authMiddleware, async (req, res) => {
  try {
    const membership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    if (membership.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit workspace settings' });
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const row = await queryOne('SELECT settings FROM workspaces WHERE id = ?', [req.params.id]);
    let current = {};
    try { current = row?.settings ? JSON.parse(row.settings) : {}; } catch { current = {}; }
    const merged = { ...current, ...patch };
    await exec('UPDATE workspaces SET settings = ? WHERE id = ?', [JSON.stringify(merged), req.params.id]);
    res.json({ success: true, settings: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Soft-delete workspace (owner only). Sets deleted_at; data retained for 30 days.
app.delete(`${BASE_PATH}/api/workspaces/:id`, authMiddleware, async (req, res) => {
  try {
    const ws = await queryOne('SELECT owner_user_id FROM workspaces WHERE id = ?', [req.params.id]);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    if (ws.owner_user_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can delete' });
    await exec('UPDATE workspaces SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List workspace members
app.get(`${BASE_PATH}/api/workspaces/:id/members`, authMiddleware, async (req, res) => {
  try {
    const membership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!membership) return res.status(404).json({ error: 'Workspace not found' });
    const result = await query(
      `SELECT u.id, u.email, u.name, u.avatar_url, wm.role, wm.joined_at, wm.invited_by
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?
       ORDER BY wm.joined_at ASC`,
      [req.params.id]
    );
    res.json({ members: result.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Invite a user (by email) into a workspace. Admin only.
app.post(`${BASE_PATH}/api/workspaces/:id/members`, authMiddleware, async (req, res) => {
  try {
    const myMembership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!myMembership) return res.status(404).json({ error: 'Workspace not found' });
    if (myMembership.role !== 'admin') return res.status(403).json({ error: 'Only admins can invite' });

    const { email, role = 'editor' } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!['admin', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const invitee = await queryOne('SELECT id FROM users WHERE email = ?', [email]);

    if (invitee) {
      // Existing user: add directly as member (no invitation flow needed).
      const existing = await queryOne(
        'SELECT 1 as x FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        [req.params.id, invitee.id]
      );
      if (existing) return res.status(409).json({ error: 'Already a member' });

      await exec(
        'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)',
        [req.params.id, invitee.id, role, req.user.id]
      );
      return res.json({ success: true, user_id: invitee.id, role, kind: 'existing_user' });
    }

    // Unregistered email: create an invitation token. Admin shares the link;
    // invitee accepts it to create their account + join in one step.
    const token = crypto.randomBytes(32).toString('hex');
    const inviteId = uuidv4();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await exec(
      `INSERT INTO invitations (id, workspace_id, email, role, token, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [inviteId, req.params.id, email, role, token, req.user.id, expiresAt]
    );
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const link = `${origin}${BASE_PATH}/#/accept-invite?token=${token}`;

    // Best-effort: also email the invitee. Admins still get the link in the
    // response as a fallback for when send fails or they want to share it
    // through a different channel (Slack/Feishu/etc).
    let emailSent = false;
    let emailError = null;
    try {
      const ws = await queryOne('SELECT name FROM workspaces WHERE id = ?', [req.params.id]);
      const inviterName = req.user.name || req.user.email || 'A teammate';
      const wsName = ws?.name || 'a workspace';
      const subject = `${inviterName} invited you to ${wsName} on InfluenceX`;
      const body = [
        `Hi,`,
        ``,
        `${inviterName} (${req.user.email}) invited you to join "${wsName}" on InfluenceX as ${role}.`,
        ``,
        `Click the link below to set your password and accept the invitation:`,
        link,
        ``,
        `This link is single-use and expires on ${new Date(expiresAt).toLocaleDateString()}.`,
        ``,
        `If you weren't expecting this email, you can safely ignore it — nothing happens until you click the link.`,
        ``,
        `— InfluenceX`,
      ].join('\n');
      const sendRes = await mailAgent.sendEmail({ to: email, subject, body, fromName: 'InfluenceX' });
      emailSent = !!sendRes.success;
      if (!sendRes.success) emailError = sendRes.error || 'send failed';
    } catch (e) {
      emailError = e.message;
      log.warn('[invitations] auto-email failed:', e.message);
    }

    res.json({
      success: true,
      kind: 'new_invitation',
      invitation: {
        id: inviteId, email, role, token, link, expires_at: expiresAt,
        email_sent: emailSent,
        email_error: emailError,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: look up an invitation by token. Used by the accept-invite page to
// show workspace name + pre-fill the email field. Intentionally leaks only
// the workspace name — not members, not other invitations.
app.get(`${BASE_PATH}/api/invitations/:token`, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, w.name AS workspace_name
       FROM invitations i JOIN workspaces w ON i.workspace_id = w.id
       WHERE i.token = ?`,
      [req.params.token]
    );
    if (!row) return res.status(404).json({ error: 'Invitation not found', code: 'INVITE_NOT_FOUND' });
    if (row.accepted_at) return res.status(410).json({ error: 'Invitation already used', code: 'INVITE_USED' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Invitation expired', code: 'INVITE_EXPIRED' });
    res.json({
      email: row.email,
      role: row.role,
      workspace_name: row.workspace_name,
      expires_at: row.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: accept an invitation. Creates the user + workspace membership in
// one atomic step. Rate-limited via authLimiter so tokens can't be brute-forced.
app.post(`${BASE_PATH}/api/invitations/:token/accept`, authLimiter, async (req, res) => {
  try {
    const { password, name } = req.body || {};
    if (!password || !name) return res.status(400).json({ error: 'password and name are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const invite = await queryOne(
      'SELECT id, workspace_id, email, role, expires_at, accepted_at FROM invitations WHERE token = ?',
      [req.params.token]
    );
    if (!invite) return res.status(404).json({ error: 'Invitation not found', code: 'INVITE_NOT_FOUND' });
    if (invite.accepted_at) return res.status(410).json({ error: 'Invitation already used', code: 'INVITE_USED' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Invitation expired', code: 'INVITE_EXPIRED' });

    // Reject if the email was registered elsewhere after the invite was sent.
    // We could silently fall through to "just log in", but the safer UX is to
    // surface the conflict so the admin can fix it.
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [invite.email]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists — log in instead', code: 'EMAIL_EXISTS' });

    const created = await registerUser(invite.email, password, name);
    if (created.error) return res.status(400).json({ error: created.error });

    await exec(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)',
      [invite.workspace_id, created.id, invite.role, (await queryOne('SELECT invited_by FROM invitations WHERE id=?', [invite.id]))?.invited_by]
    );
    await exec(
      'UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = ? WHERE id = ?',
      [created.id, invite.id]
    );

    // Auto-login so the client can hop straight into the app.
    const login = await loginUser(invite.email, password);
    res.json(login);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Invite Codes (admin-managed, public-redeemable) ====================
//
// Distinct from per-email `invitations`: invite_codes are generic, sharable
// strings that any new user can use to register. Only platform admins
// (users.role = 'admin') can create them. Each code targets a specific
// workspace + role; redeeming creates the user and joins them in one step.

function generateInviteCode() {
  // Format: INFLX-XXXXXXXX (8-char base32; ~40 bits of entropy). Avoids
  // ambiguous chars (0/O, 1/I/L) so users can read codes off chat or paper.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `INFLX-${s}`;
}

// Admin-only: create a new invite code.
// Body: { workspaceId, role?, maxUses?, expiresInDays?, note? }
app.post(`${BASE_PATH}/api/invite-codes`, authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only platform admins can create invite codes' });
    }
    const { workspaceId, role = 'editor', maxUses = 1, expiresInDays, note } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
    if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const uses = parseInt(maxUses, 10);
    if (!Number.isFinite(uses) || uses < 1 || uses > 1000) return res.status(400).json({ error: 'maxUses must be between 1 and 1000' });

    const ws = await queryOne('SELECT id FROM workspaces WHERE id = ?', [workspaceId]);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    let expiresAt = null;
    if (expiresInDays != null) {
      const days = parseInt(expiresInDays, 10);
      if (!Number.isFinite(days) || days < 1 || days > 365) return res.status(400).json({ error: 'expiresInDays must be between 1 and 365' });
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    // Try a few times in the rare case of code collision.
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = generateInviteCode();
      const dup = await queryOne('SELECT id FROM invite_codes WHERE code = ?', [candidate]);
      if (!dup) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate unique invite code, try again' });

    const id = uuidv4();
    await exec(
      `INSERT INTO invite_codes (id, code, workspace_id, role, max_uses, used_count, expires_at, note, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, code, workspaceId, role, uses, expiresAt, note || null, req.user.id]
    );

    res.json({
      id, code, workspace_id: workspaceId, role, max_uses: uses, used_count: 0,
      expires_at: expiresAt, note: note || null, created_by: req.user.id, created_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-only: list all invite codes (across all workspaces).
app.get(`${BASE_PATH}/api/invite-codes`, authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only platform admins can list invite codes' });
    }
    const result = await query(
      `SELECT ic.*, w.name AS workspace_name, u.email AS created_by_email
       FROM invite_codes ic
       LEFT JOIN workspaces w ON ic.workspace_id = w.id
       LEFT JOIN users u ON ic.created_by = u.id
       ORDER BY ic.created_at DESC`
    );
    res.json({ codes: result.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-only: list recent Apify runs for ops debugging. Optional ?status=failed
// or ?status=timeout to triage. Returns the latest 100 by default.
app.get(`${BASE_PATH}/api/admin/apify-runs`, authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only platform admins can view Apify runs' });
    }
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const runs = await apifyWatchdog.listRecentRuns({ query }, { status, limit });
    res.json({ runs, threshold_minutes: apifyWatchdog.STUCK_THRESHOLD_MINUTES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-only: trigger a watchdog sweep on demand (in addition to the cron).
app.post(`${BASE_PATH}/api/admin/apify-runs/reap`, authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only platform admins can reap stuck runs' });
    }
    const r = await apifyWatchdog.reapStuckRuns({ exec, query });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-only: revoke (soft-delete) an invite code.
app.delete(`${BASE_PATH}/api/invite-codes/:id`, authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only platform admins can revoke invite codes' });
    }
    const ic = await queryOne('SELECT id, revoked_at FROM invite_codes WHERE id = ?', [req.params.id]);
    if (!ic) return res.status(404).json({ error: 'Invite code not found' });
    if (ic.revoked_at) return res.json({ success: true, already_revoked: true });
    await exec('UPDATE invite_codes SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: look up an invite code (no auth needed). Returns workspace name +
// remaining uses so the signup page can show context. Does NOT reveal the
// creator email or full audit trail.
app.get(`${BASE_PATH}/api/invite-codes/lookup/:code`, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code is required', code: 'CODE_REQUIRED' });
    const ic = await queryOne(
      `SELECT ic.id, ic.code, ic.role, ic.max_uses, ic.used_count, ic.expires_at, ic.revoked_at, w.name AS workspace_name
       FROM invite_codes ic LEFT JOIN workspaces w ON ic.workspace_id = w.id
       WHERE ic.code = ?`,
      [code]
    );
    if (!ic) return res.status(404).json({ error: 'Invite code not found', code: 'CODE_NOT_FOUND' });
    if (ic.revoked_at) return res.status(410).json({ error: 'This invite code has been revoked', code: 'CODE_REVOKED' });
    if (ic.expires_at && new Date(ic.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite code has expired', code: 'CODE_EXPIRED' });
    }
    if (ic.used_count >= ic.max_uses) {
      return res.status(410).json({ error: 'This invite code has reached its usage limit', code: 'CODE_EXHAUSTED' });
    }
    res.json({
      code: ic.code,
      workspace_name: ic.workspace_name,
      role: ic.role,
      remaining_uses: ic.max_uses - ic.used_count,
      expires_at: ic.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: register a new account using an invite code.
// Body: { code, email, password, name }
app.post(`${BASE_PATH}/api/auth/register-with-code`, authLimiter, async (req, res) => {
  try {
    const { code: rawCode, email, password, name } = req.body || {};
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Invite code is required', code: 'CODE_REQUIRED' });
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Re-validate the code under the same rules as /lookup, then atomically
    // increment used_count. SQLite + Postgres both honor row-level updates so
    // a SELECT-then-UPDATE-WHERE-used_count<max is the simplest way to keep
    // two concurrent redemptions from over-consuming.
    const ic = await queryOne(
      `SELECT id, workspace_id, role, max_uses, used_count, expires_at, revoked_at
       FROM invite_codes WHERE code = ?`,
      [code]
    );
    if (!ic) return res.status(404).json({ error: 'Invite code not found', code: 'CODE_NOT_FOUND' });
    if (ic.revoked_at) return res.status(410).json({ error: 'Invite code revoked', code: 'CODE_REVOKED' });
    if (ic.expires_at && new Date(ic.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite code expired', code: 'CODE_EXPIRED' });
    }
    if (ic.used_count >= ic.max_uses) {
      return res.status(410).json({ error: 'Invite code exhausted', code: 'CODE_EXHAUSTED' });
    }

    const dup = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (dup) return res.status(409).json({ error: 'An account with this email already exists — log in instead', code: 'EMAIL_EXISTS' });

    // Reserve a use first (optimistic lock). If this UPDATE didn't bump the
    // counter (because another request beat us), bail out before creating
    // the user.
    const before = ic.used_count;
    await exec(
      `UPDATE invite_codes SET used_count = used_count + 1
       WHERE id = ? AND used_count = ? AND used_count < max_uses`,
      [ic.id, before]
    );
    const after = await queryOne('SELECT used_count FROM invite_codes WHERE id = ?', [ic.id]);
    if (!after || after.used_count !== before + 1) {
      return res.status(409).json({ error: 'Code was just used by someone else, please try again', code: 'CODE_RACE' });
    }

    const created = await registerUser(email, password, name);
    if (created.error) {
      // Roll back the use we reserved so the code isn't burned.
      await exec('UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ?', [ic.id]);
      return res.status(400).json({ error: created.error });
    }

    await exec(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)',
      [ic.workspace_id, created.id, ic.role, null]
    );
    await exec(
      'INSERT INTO invite_code_redemptions (id, invite_code_id, user_id, email) VALUES (?, ?, ?, ?)',
      [uuidv4(), ic.id, created.id, email]
    );

    const login = await loginUser(email, password);
    res.json(login);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Change member role. Admin only.
app.patch(`${BASE_PATH}/api/workspaces/:id/members/:userId/role`, authMiddleware, async (req, res) => {
  try {
    const myMembership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!myMembership) return res.status(404).json({ error: 'Workspace not found' });
    if (myMembership.role !== 'admin') return res.status(403).json({ error: 'Only admins can change roles' });

    const { role } = req.body;
    if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });

    await exec(
      'UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      [role, req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a member. Admin only; cannot remove yourself.
app.delete(`${BASE_PATH}/api/workspaces/:id/members/:userId`, authMiddleware, async (req, res) => {
  try {
    const myMembership = await queryOne(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!myMembership) return res.status(404).json({ error: 'Workspace not found' });
    if (myMembership.role !== 'admin') return res.status(403).json({ error: 'Only admins can remove members' });
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself — transfer ownership or leave via a separate action' });

    await exec(
      'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Protect all API routes below ====================
app.use(`${BASE_PATH}/api`, (req, res, next) => {
  // Skip auth routes
  if (req.path.startsWith('/auth/')) return next();
  // Inbound webhooks (Resend email events, Stripe, etc.) authenticate via
  // their own signature checks, not bearer tokens.
  if (req.path.startsWith('/webhooks/')) return next();
  // SSE streams authenticate via query-string (EventSource can't set headers)
  if (/^\/agents\/runs\/[^/]+\/stream$/.test(req.path)) return next();
  // OAuth callbacks — the provider redirects here without auth; the state
  // table acts as the authenticity check.
  if (/^\/publish\/oauth\/[^/]+\/callback$/.test(req.path)) return next();
  if (req.path === '/mailboxes/oauth/gmail/callback') return next();
  authMiddleware(req, res, next);
});

// ==================== Workspace context ====================
//
// Apply lenient workspace context to paths that operate on workspace-scoped
// data. Lenient = falls back to the user's default workspace if no explicit
// id is provided (legacy-client support). Strict STRICT_WORKSPACE_SCOPE can
// be toggled later once every handler is migrated.
//
// Paths NOT needing workspace context: auth, user management, webhooks,
// docs, platform-level stats/quota/queue/cache, global email templates.
const WORKSPACE_SKIP_PREFIXES = [
  '/auth/', '/users', '/webhooks/', '/openapi', '/docs',
  '/quota/', '/cache/', '/queue/', '/apify/',
  '/query/', '/scheduler/', '/stats',
  '/mailboxes/oauth/gmail/callback', // Gmail OAuth callback resolves workspace from state
];
app.use(`${BASE_PATH}/api`, (req, res, next) => {
  // OAuth callbacks resolve workspace from the state row (no auth, no headers).
  // The /init endpoint, in contrast, IS authenticated and requires workspace context.
  if (/^\/publish\/oauth\/[^/]+\/callback$/.test(req.path)) return next();
  if (WORKSPACE_SKIP_PREFIXES.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }
  workspaceContext({ lenient: true })(req, res, next);
});

// ==================== Campaign API ====================
//
// Workspace-scoped. Legacy clients (no X-Workspace-Id header) automatically
// resolve to the user's default workspace via the global lenient context
// middleware registered above. The SQL uses scoped() which enforces
// workspace_id presence in every query.

// List campaigns in the current workspace
app.get(`${BASE_PATH}/api/campaigns`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC',
      [req.workspace.id]
    );
    const campaigns = result.rows;
    for (const c of campaigns) {
      c.platforms = JSON.parse(c.platforms || '[]');
      c.filter_criteria = JSON.parse(c.filter_criteria || '{}');
      const stats = await s.queryOne(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved FROM kols WHERE campaign_id = ? AND workspace_id = ?",
        [c.id, req.workspace.id]
      );
      c.kol_total = parseInt(stats.total) || 0;
      c.kol_approved = parseInt(stats.approved) || 0;
    }
    res.json(campaigns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create campaign in the current workspace
app.post(`${BASE_PATH}/api/campaigns`, async (req, res) => {
  try {
    const { name, description, platforms, daily_target, filter_criteria, budget } = req.body;
    const id = uuidv4();
    const s = scoped(req.workspace.id);
    await s.exec(
      'INSERT INTO campaigns (id, workspace_id, name, description, platforms, daily_target, filter_criteria, budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, name, description || '', JSON.stringify(platforms || []), daily_target || 10, JSON.stringify(filter_criteria || {}), budget || 0]
    );
    res.json({ id, name, description, platforms, daily_target, filter_criteria, budget, status: 'active' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single campaign — scoped so users can only see campaigns in their workspace
app.get(`${BASE_PATH}/api/campaigns/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const campaign = await s.queryOne(
      'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    campaign.platforms = JSON.parse(campaign.platforms || '[]');
    campaign.filter_criteria = JSON.parse(campaign.filter_criteria || '{}');
    res.json(campaign);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update campaign
app.put(`${BASE_PATH}/api/campaigns/:id`, async (req, res) => {
  try {
    const { name, description, platforms, daily_target, filter_criteria, status } = req.body;
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'UPDATE campaigns SET name=?, description=?, platforms=?, daily_target=?, filter_criteria=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?',
      [name, description, JSON.stringify(platforms || []), daily_target, JSON.stringify(filter_criteria || {}), status, req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete campaign
app.delete(`${BASE_PATH}/api/campaigns/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'DELETE FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== KOL API ====================

// List KOLs for a campaign
app.get(`${BASE_PATH}/api/campaigns/:campaignId/kols`, async (req, res) => {
  try {
    const { status, platform, search } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT * FROM kols WHERE workspace_id = ? AND campaign_id = ?';
    const params = [req.workspace.id, req.params.campaignId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (platform) { sql += ' AND platform = ?'; params.push(platform); }
    if (search) { sql += ' AND (username LIKE ? OR display_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY collected_at DESC';
    const result = await s.query(sql, params);
    const kols = result.rows;
    kols.forEach(k => k.contact_info = JSON.parse(k.contact_info || '{}'));
    res.json(kols);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add KOL (manual or from collection)
app.post(`${BASE_PATH}/api/campaigns/:campaignId/kols`, async (req, res) => {
  try {
    const { platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, contact_info, profile_url, bio } = req.body;
    const s = scoped(req.workspace.id);
    // Verify campaign is in this workspace before attaching KOL
    const parent = await s.queryOne(
      'SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.campaignId, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Campaign not found' });
    const id = uuidv4();
    await s.exec(
      'INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, contact_info, profile_url, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, req.params.campaignId, platform, username, display_name || username, avatar_url || '', followers || 0, engagement_rate || 0, avg_views || 0, category || '', email || '', JSON.stringify(contact_info || {}), profile_url || '', bio || '']
    );
    res.json({ id, platform, username, display_name, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Collect KOLs for a campaign — uses real YouTube Discovery API if configured,
// falls back to demo sample generator if no API keys are set
app.post(`${BASE_PATH}/api/campaigns/:campaignId/kols/collect`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const campaign = await s.queryOne(
      'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.campaignId, req.workspace.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const platforms = JSON.parse(campaign.platforms || '[]');
    const target = Math.min(campaign.daily_target || 10, 50);
    const criteria = JSON.parse(campaign.filter_criteria || '{}');
    const keywords = req.body.keywords || criteria.categories || campaign.description || 'gaming';

    const useRealAPI = !!YOUTUBE_API_KEY && (platforms.length === 0 || platforms.includes('youtube'));
    let collectedKols = [];
    let source = 'demo';

    if (useRealAPI) {
      // Real collection via YouTube Discovery agent
      source = 'youtube-api';
      const discoveryResult = await discoveryAgent.searchYouTubeChannels({
        keywords: Array.isArray(keywords) ? keywords.join(', ') : keywords,
        minSubscribers: criteria.min_followers || 5000,
        maxResults: target,
      }).catch(err => {
        console.error('[collect] Discovery failed, falling back to demo:', err.message);
        return null;
      });

      if (discoveryResult?.success && discoveryResult.channels?.length) {
        collectedKols = discoveryResult.channels.slice(0, target).map(ch => ({
          id: uuidv4(),
          platform: 'youtube',
          username: ch.channelId,
          display_name: ch.channel_name,
          avatar_url: ch.avatar_url || '',
          followers: ch.subscribers || 0,
          engagement_rate: 0,
          avg_views: 0,
          category: ch.category || 'Unknown',
          email: null,
          contact_info: {},
          profile_url: ch.channel_url,
          bio: ch.description || '',
        }));
      }
    }

    // Fallback to demo data if no API or no results
    if (collectedKols.length === 0) {
      source = useRealAPI ? 'demo-fallback' : 'demo';
      collectedKols = generateSampleKols(platforms, target, criteria);
    }

    // Apply AI scoring (deterministic)
    collectedKols.forEach(k => {
      const score = calculateAIScore(k, criteria, campaign.description || '');
      k.ai_score = score.score;
      k.ai_reason = score.reason;
      k.estimated_cpm = score.estimatedCpm;
    });
    collectedKols.sort((a, b) => b.ai_score - a.ai_score);

    await transaction(async (tx) => {
      for (const k of collectedKols) {
        await tx.exec(
          'INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, contact_info, profile_url, bio, ai_score, ai_reason, estimated_cpm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [k.id, req.workspace.id, req.params.campaignId, k.platform, k.username, k.display_name, k.avatar_url, k.followers, k.engagement_rate, k.avg_views, k.category, k.email, JSON.stringify(k.contact_info || {}), k.profile_url, k.bio, k.ai_score, k.ai_reason, k.estimated_cpm]
        );
      }
    });
    res.json({ collected: collectedKols.length, source, kols: collectedKols });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch update KOL status (must be before :id route)
app.patch(`${BASE_PATH}/api/kols/batch`, async (req, res) => {
  try {
    const { ids, status } = req.body;
    await transaction(async (tx) => {
      for (const id of ids) {
        await tx.exec('UPDATE kols SET status = ? WHERE id = ? AND workspace_id = ?', [status, id, req.workspace.id]);
      }
    });
    res.json({ success: true, updated: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update KOL status (approve/reject)
app.patch(`${BASE_PATH}/api/kols/:id`, async (req, res) => {
  try {
    const { status } = req.body;
    const s = scoped(req.workspace.id);
    const result = await s.exec('UPDATE kols SET status = ? WHERE id = ? AND workspace_id = ?', [status, req.params.id, req.workspace.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'KOL not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Contact API ====================

// List contacts for a campaign
app.get(`${BASE_PATH}/api/campaigns/:campaignId/contacts`, async (req, res) => {
  try {
    const { status } = req.query;
    const s = scoped(req.workspace.id);
    let sql = `SELECT c.*, k.id as kol_row_id, k.username, k.display_name, k.platform, k.avatar_url,
                 k.followers, k.email as kol_email, k.email_blocked_at, k.email_blocked_reason
      FROM contacts c JOIN kols k ON c.kol_id = k.id WHERE c.workspace_id = ? AND c.campaign_id = ?`;
    const params = [req.workspace.id, req.params.campaignId];
    if (status) { sql += ' AND c.status = ?'; params.push(status); }
    sql += ' ORDER BY c.created_at DESC';
    const result = await s.query(sql, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate email for a KOL contact
app.post(`${BASE_PATH}/api/contacts/generate`, async (req, res) => {
  try {
    const { kol_id, campaign_id, cooperation_type, price_quote } = req.body;
    const s = scoped(req.workspace.id);
    const kol = await s.queryOne('SELECT * FROM kols WHERE id = ? AND workspace_id = ?', [kol_id, req.workspace.id]);
    const campaign = await s.queryOne('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [campaign_id, req.workspace.id]);
    if (!kol || !campaign) return res.status(404).json({ error: 'KOL or Campaign not found' });

    const email = await generateOutreachEmail(kol, campaign, cooperation_type || 'affiliate', price_quote);
    const id = uuidv4();
    await s.exec(
      'INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, price_quote, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, kol_id, campaign_id, email.subject, email.body, cooperation_type || 'affiliate', price_quote || '', 'draft']
    );
    res.json({ id, ...email, status: 'draft' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update contact (edit email before sending)
app.put(`${BASE_PATH}/api/contacts/:id`, async (req, res) => {
  try {
    const { email_subject, email_body, cooperation_type, price_quote, notes,
            contract_status, contract_url, content_status, content_url, content_due_date,
            payment_amount, payment_status, mailbox_account_id } = req.body;
    const s = scoped(req.workspace.id);
    // mailbox_account_id: undefined = leave as-is, null = clear, id = set.
    // We use a three-value handling via sentinel because COALESCE can't
    // distinguish "unset" from "set to null".
    const mailboxClause = mailbox_account_id === undefined ? 'mailbox_account_id=mailbox_account_id' : 'mailbox_account_id=?';
    const params = [
      email_subject, email_body, cooperation_type, price_quote, notes,
      contract_status || null, contract_url || null,
      content_status || null, content_url || null, content_due_date || null,
      payment_amount || null, payment_status || null,
    ];
    if (mailbox_account_id !== undefined) params.push(mailbox_account_id || null);
    params.push(req.params.id, req.workspace.id);
    const result = await s.exec(
      `UPDATE contacts SET email_subject=?, email_body=?, cooperation_type=?, price_quote=?, notes=?,
       contract_status=COALESCE(?, contract_status), contract_url=COALESCE(?, contract_url),
       content_status=COALESCE(?, content_status), content_url=COALESCE(?, content_url),
       content_due_date=COALESCE(?, content_due_date),
       payment_amount=COALESCE(?, payment_amount), payment_status=COALESCE(?, payment_status),
       ${mailboxClause}
       WHERE id=? AND workspace_id=?`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update contact workflow status (contract, content, payment)
app.patch(`${BASE_PATH}/api/contacts/:id/workflow`, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    const fields = ['contract_status', 'contract_url', 'content_status', 'content_url', 'content_due_date', 'payment_amount', 'payment_status', 'status'];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f}=?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.workspace.id, req.params.id);
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      `UPDATE contacts SET ${updates.join(', ')} WHERE workspace_id=? AND id=?`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enqueue an email send. Returns immediately with status='pending'; the
// background job performs the actual provider call, records events, and
// handles retries. Polling the contact's status shows progress.
app.post(`${BASE_PATH}/api/contacts/:id/send`, sendEmailLimiter, sendEmailWorkspaceLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const contact = await s.queryOne(
      `SELECT c.*, k.email as kol_email
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.id = ? AND c.workspace_id = ?`,
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const emailTo = req.body.email_to || contact.kol_email;
    if (!emailTo) return res.status(400).json({ error: 'No recipient email address found for this KOL' });
    if (!contact.email_subject || !contact.email_body) {
      return res.status(400).json({ error: 'Email subject/body is empty — generate or edit first' });
    }

    // Mark pending so UI reflects in-flight state immediately.
    await s.exec(
      `UPDATE contacts SET status='pending', send_error=NULL WHERE id=? AND workspace_id=?`,
      [req.params.id, req.workspace.id]
    );

    const jobId = jobQueue.push('email.send', {
      contactId: req.params.id,
      toOverride: req.body.email_to || null,
    }, { maxRetries: 3 });

    res.json({ success: true, queued: true, jobId, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-retry a failed send. Clears the error and re-enqueues.
app.post(`${BASE_PATH}/api/contacts/:id/retry`, sendEmailLimiter, sendEmailWorkspaceLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const contact = await s.queryOne(
      'SELECT id FROM contacts WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    await s.exec(
      `UPDATE contacts SET status='pending', send_error=NULL WHERE id=? AND workspace_id=?`,
      [req.params.id, req.workspace.id]
    );
    const jobId = jobQueue.push('email.send', { contactId: req.params.id }, { maxRetries: 3 });
    res.json({ success: true, queued: true, jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch send: enqueue sends for a list of contact ids (scoped to campaign/workspace).
// Optional body.template_id: apply this template (with per-KOL variable
// rendering + A/B variant pick) to every contact before enqueuing. This lets
// users go from "selected 30 drafts" → "fire one template across all" in one
// action, matching the plan's "批量发送" flow.
app.post(`${BASE_PATH}/api/campaigns/:campaignId/contacts/batch-send`, sendEmailLimiter, async (req, res) => {
  try {
    const { contact_ids = [], template_id } = req.body || {};
    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      return res.status(400).json({ error: 'contact_ids required (non-empty array)' });
    }
    // Reject up-front if the batch exceeds the per-workspace RPM budget.
    // This is a best-effort guard — the actual queue spreads sends over time
    // so an over-cap batch might still drain fine, but returning 429 here
    // gives users clear feedback before we mark rows as pending.
    if (contact_ids.length > EMAIL_SEND_WORKSPACE_RPM) {
      return res.status(429).json({
        error: `Batch size ${contact_ids.length} exceeds workspace rate limit ${EMAIL_SEND_WORKSPACE_RPM}/min. Split into smaller batches.`,
      });
    }
    const s = scoped(req.workspace.id);
    const placeholders = contact_ids.map(() => '?').join(',');
    const result = await s.query(
      `SELECT c.id, c.email_subject, c.email_body, c.status, c.cooperation_type, c.price_quote,
              c.campaign_id,
              k.email as kol_email, k.display_name, k.username, k.platform, k.followers, k.category
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.workspace_id = ? AND c.campaign_id = ? AND c.id IN (${placeholders})`,
      [req.workspace.id, req.params.campaignId, ...contact_ids]
    );

    // If a template was supplied, preload the parent + its variants once so
    // we can spread the picks across contacts without refetching per-row.
    let templatePool = null;
    let templateIsCustom = false;
    if (template_id) {
      const builtin = emailTemplates.listTemplates().find(t => t.id === template_id);
      if (builtin) {
        templatePool = [{ id: template_id, isBuiltin: true }];
      } else {
        const parent = await s.queryOne(
          'SELECT * FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
          [template_id, req.workspace.id]
        );
        if (!parent) return res.status(404).json({ error: 'Template not found' });
        const vrs = await s.query(
          'SELECT * FROM email_templates WHERE variant_of = ? AND workspace_id = ?',
          [template_id, req.workspace.id]
        );
        templatePool = [parent, ...(vrs.rows || [])].map(t => ({ ...t, isBuiltin: false }));
        templateIsCustom = true;
      }
    }

    const campaign = await s.queryOne(
      'SELECT name FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.campaignId, req.workspace.id]
    );

    const eligible = [];
    const skipped = [];
    for (const c of result.rows) {
      if (!c.kol_email) { skipped.push({ id: c.id, reason: 'no_email' }); continue; }
      if (['sent', 'delivered', 'opened', 'replied'].includes(c.status)) { skipped.push({ id: c.id, reason: 'already_' + c.status }); continue; }

      // Apply template if provided. Render variables per-contact and write
      // the resulting subject/body + A/B attribution onto the contact row.
      if (templatePool && templatePool.length > 0) {
        const chosen = templatePool[Math.floor(Math.random() * templatePool.length)];
        const vars = {
          kol_name: c.display_name || c.username,
          kol_handle: c.username,
          platform: c.platform || '',
          followers: emailTemplates.formatFollowers(c.followers),
          category: c.category || '',
          campaign_name: campaign?.name || '',
          sender_name: process.env.SENDER_NAME || 'The Team',
          product_name: process.env.PRODUCT_NAME || campaign?.name || '',
          cooperation_type: c.cooperation_type || '',
          price_quote: c.price_quote || '',
        };
        let subject, body;
        if (chosen.isBuiltin) {
          const r = emailTemplates.renderEmail(chosen.id, vars);
          subject = r.subject; body = r.body;
        } else {
          subject = emailTemplates.renderTemplate(chosen.subject, vars);
          body = emailTemplates.renderTemplate(chosen.body, vars);
        }
        await s.exec(
          `UPDATE contacts SET email_subject = ?, email_body = ?, template_id = ?, variant_id = ? WHERE id = ? AND workspace_id = ?`,
          [subject, body,
            templateIsCustom ? template_id : null,
            templateIsCustom && chosen.id !== template_id ? chosen.id : null,
            c.id, req.workspace.id]
        );
      } else if (!c.email_subject || !c.email_body) {
        skipped.push({ id: c.id, reason: 'empty_body' }); continue;
      }

      eligible.push(c.id);
    }

    if (eligible.length === 0) {
      return res.status(400).json({ error: 'No eligible contacts', skipped });
    }

    // Mark all eligible as pending in one statement.
    const markPlaceholders = eligible.map(() => '?').join(',');
    await s.exec(
      `UPDATE contacts SET status='pending', send_error=NULL WHERE workspace_id = ? AND id IN (${markPlaceholders})`,
      [req.workspace.id, ...eligible]
    );

    const jobId = jobQueue.push('email.batch_send', { contactIds: eligible }, { maxRetries: 0 });
    res.json({ success: true, queued: eligible.length, skipped, jobId, templateApplied: !!template_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record reply (manual)
app.post(`${BASE_PATH}/api/contacts/:id/reply`, async (req, res) => {
  try {
    const { reply_content } = req.body;
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      "UPDATE contacts SET status='replied', reply_content=?, reply_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [reply_content, req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    // Also save to email_replies table
    await s.exec(
      "INSERT INTO email_replies (id, workspace_id, contact_id, direction, body_text, received_at) VALUES (?, ?, ?, 'inbound', ?, CURRENT_TIMESTAMP)",
      [uuidv4(), req.workspace.id, req.params.id, reply_content]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Resend Inbound Webhook ====================
// Receives KOL reply emails forwarded by Resend to market@hakko.ai
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

function verifyResendSignature(req) {
  if (!RESEND_WEBHOOK_SECRET) return true; // skip if not configured
  const signature = req.headers['resend-signature'] || req.headers['svix-signature'] || '';
  const timestamp = req.headers['svix-timestamp'] || '';
  const msgId = req.headers['svix-id'] || '';
  if (!signature || !timestamp) return false;

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const toSign = `${msgId}.${timestamp}.${rawBody}`;
  // Resend uses Svix webhooks: secret is base64-encoded after "whsec_" prefix
  const secretBytes = Buffer.from(RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
  const expectedSig = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');

  // Signature header may contain multiple sigs: "v1,<base64>"
  const sigs = signature.split(' ').map(s => s.replace('v1,', ''));
  return sigs.some(s => s === expectedSig);
}

app.post(`${BASE_PATH}/api/webhooks/resend/inbound`, async (req, res) => {
  // Verify webhook signature
  if (RESEND_WEBHOOK_SECRET && !verifyResendSignature(req)) {
    console.warn('[Inbound Email] Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const { from, to, subject, text, html, headers } = req.body;
    const fromEmail = typeof from === 'string' ? from : (from?.email || from?.[0]?.email || '');
    const toEmail = typeof to === 'string' ? to : (to?.email || to?.[0]?.email || '');
    const inReplyTo = headers?.['In-Reply-To'] || headers?.['in-reply-to'] || '';
    const bodyText = text || '';
    const bodyHtml = html || '';

    console.log(`[Inbound Email] From: ${fromEmail}, Subject: ${subject}`);

    // Try to match to a contact/pipeline by sender email
    let contactId = null;
    let pipelineJobId = null;

    // Search pipeline_jobs by email_to (the KOL's email we sent to)
    const pipelineJob = await queryOne("SELECT * FROM pipeline_jobs WHERE email_to=? AND stage='monitor'", [fromEmail]);
    if (pipelineJob) {
      pipelineJobId = pipelineJob.id;
      contactId = pipelineJob.contact_id;
      // Update pipeline job
      await exec("UPDATE pipeline_jobs SET reply_detected=1, reply_content=?, stage='replied', updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [bodyText.substring(0, 2000), pipelineJob.id]);
    }

    // Search contacts by KOL email (through kols table)
    if (!contactId) {
      const contact = await queryOne(
        "SELECT c.id FROM contacts c JOIN kols k ON c.kol_id=k.id WHERE k.email=? ORDER BY c.created_at DESC LIMIT 1",
        [fromEmail]
      );
      if (contact) contactId = contact.id;
    }

    // Resolve workspace_id from the matched contact or pipeline_job so the
    // saved reply is visible through scoped() queries.
    let workspaceId = null;
    if (contactId) {
      const c = await queryOne('SELECT workspace_id FROM contacts WHERE id = ?', [contactId]);
      workspaceId = c?.workspace_id || null;
    }
    if (!workspaceId && pipelineJobId) {
      const pj = await queryOne('SELECT workspace_id FROM pipeline_jobs WHERE id = ?', [pipelineJobId]);
      workspaceId = pj?.workspace_id || null;
    }

    // Update contact status
    if (contactId) {
      await exec("UPDATE contacts SET status='replied', reply_content=?, reply_at=CURRENT_TIMESTAMP WHERE id=?",
        [bodyText.substring(0, 2000), contactId]);
    }

    // Save the full reply
    await exec(
      "INSERT INTO email_replies (id, workspace_id, contact_id, pipeline_job_id, direction, from_email, to_email, subject, body_text, body_html, in_reply_to, received_at) VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      [uuidv4(), workspaceId, contactId, pipelineJobId, fromEmail, toEmail, subject || '', bodyText, bodyHtml, inReplyTo]
    );

    console.log(`[Inbound Email] Saved. contact_id=${contactId}, pipeline_job_id=${pipelineJobId}`);

    res.json({ success: true, contactId, pipelineJobId });
  } catch (e) {
    console.error('[Inbound Email] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== Resend Events Webhook ====================
// Handles delivered / opened / bounced / complained / clicked events. Resend
// sends the same signed-Svix envelope as the inbound webhook; same secret
// is expected (set RESEND_WEBHOOK_SECRET).
app.post(`${BASE_PATH}/api/webhooks/resend/events`, async (req, res) => {
  if (RESEND_WEBHOOK_SECRET && !verifyResendSignature(req)) {
    console.warn('[Email Events] Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let recorded = 0;

    for (const ev of events) {
      // Resend event shape: { type: 'email.delivered', data: { email_id, to, ... } }
      const type = ev.type || ev.event || 'unknown';
      const data = ev.data || ev;
      const messageId = data.email_id || data.message_id || data.id;
      if (!messageId) continue;

      // Locate contact by provider_message_id or by outbound email_replies.resend_email_id
      let contactId = null;
      let workspaceId = null;
      const fromContacts = await queryOne(
        'SELECT id, workspace_id FROM contacts WHERE provider_message_id = ?',
        [messageId]
      );
      if (fromContacts) {
        contactId = fromContacts.id;
        workspaceId = fromContacts.workspace_id;
      } else {
        const fromReplies = await queryOne(
          "SELECT contact_id, workspace_id FROM email_replies WHERE resend_email_id = ? AND direction='outbound' LIMIT 1",
          [messageId]
        );
        if (fromReplies) {
          contactId = fromReplies.contact_id;
          workspaceId = fromReplies.workspace_id;
        }
      }

      // Short type key for downstream consumers
      const shortType = type.replace(/^email\./, '');
      await exec(
        `INSERT INTO email_events (id, workspace_id, contact_id, provider_message_id, event_type, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), workspaceId, contactId, messageId, shortType, JSON.stringify(ev)]
      );
      recorded += 1;

      if (!contactId) continue;

      // Mirror notable events into contacts.status/timestamps
      if (shortType === 'delivered') {
        await exec(
          `UPDATE contacts SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
           status = CASE WHEN status IN ('pending','sent') THEN 'delivered' ELSE status END
           WHERE id = ?`,
          [contactId]
        );
      } else if (shortType === 'opened') {
        await exec(
          `UPDATE contacts SET
             first_opened_at = COALESCE(first_opened_at, CURRENT_TIMESTAMP),
             last_opened_at = CURRENT_TIMESTAMP,
             status = CASE WHEN status IN ('pending','sent','delivered') THEN 'opened' ELSE status END
           WHERE id = ?`,
          [contactId]
        );
      } else if (shortType === 'bounced' || shortType === 'bounce') {
        const reason = data.reason || data.bounce_type || 'bounced';
        await exec(
          `UPDATE contacts SET status = 'bounced', bounce_reason = ? WHERE id = ?`,
          [String(reason).slice(0, 500), contactId]
        );
        await maybeBlockKol(contactId, `bounce: ${reason}`);
      } else if (shortType === 'complained') {
        await exec(
          `UPDATE contacts SET status = 'bounced', bounce_reason = COALESCE(bounce_reason, 'complained') WHERE id = ?`,
          [contactId]
        );
        // Spam complaints are strictly worse than bounces — block on the first one.
        await maybeBlockKol(contactId, 'spam complaint', { threshold: 1 });
      }
    }

    res.json({ success: true, recorded });
  } catch (e) {
    console.error('[Email Events] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== Apify webhooks (skeleton) ====================
//
// Apify can fire webhooks when an actor run finishes / fails / aborts. This
// receiver verifies the optional shared secret and updates the apify_runs row
// for the matching run_id. Used by the async run mode (Roadmap §4.1) — the
// current sync mode bypasses this entirely, but having the endpoint live now
// means we can switch any actor to async without another deploy.
const APIFY_WEBHOOK_SECRET = process.env.APIFY_WEBHOOK_SECRET || '';

function verifyApifySignature(req) {
  if (!APIFY_WEBHOOK_SECRET) return true; // skip if not configured
  const provided = req.headers['x-apify-webhook-signature'] || req.headers['apify-webhook-signature'] || '';
  if (!provided) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha256', APIFY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  // Constant-time compare. Apify's signature is hex.
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

app.post(`${BASE_PATH}/api/webhooks/apify`, async (req, res) => {
  if (APIFY_WEBHOOK_SECRET && !verifyApifySignature(req)) {
    console.warn('[apify-webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    // Apify webhook payload shape:
    //   { eventType: 'ACTOR.RUN.SUCCEEDED' | '...FAILED' | '...ABORTED' | '...TIMED_OUT',
    //     resource: { id, actId, status, defaultDatasetId, ... },
    //     userId, createdAt, ... }
    const evt = req.body || {};
    const runId = evt.resource?.id;
    const actorId = evt.resource?.actId;
    const status = evt.resource?.status;

    if (!runId) {
      return res.status(400).json({ error: 'Missing resource.id', code: 'NO_RUN_ID' });
    }

    // Map Apify status → our internal status enum.
    const statusMap = {
      SUCCEEDED: 'succeeded',
      FAILED: 'failed',
      ABORTED: 'failed',
      TIMED_OUT: 'timeout',
      RUNNING: 'running',
    };
    const internalStatus = statusMap[status] || 'failed';

    // Update the matching apify_runs row (by run_id Apify gave us). If we
    // never recorded this run (e.g. webhook arrives for an actor we don't
    // own), insert a new row so ops can still see the event.
    const existing = await queryOne('SELECT id FROM apify_runs WHERE run_id = ? LIMIT 1', [runId]);
    if (existing) {
      await exec(
        `UPDATE apify_runs SET status = ?, finished_at = CURRENT_TIMESTAMP,
         result_summary = COALESCE(result_summary, ?), error_message = COALESCE(error_message, ?)
         WHERE id = ?`,
        [internalStatus, JSON.stringify({ via: 'webhook' }), evt.resource?.statusMessage || null, existing.id]
      );
    } else {
      await exec(
        `INSERT INTO apify_runs (id, actor_id, run_id, status, result_summary, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [uuidv4(), actorId || 'unknown', runId, internalStatus, JSON.stringify({ via: 'webhook', orphan: true })]
      );
    }

    res.json({ ok: true, runId, status: internalStatus });
  } catch (e) {
    console.error('[apify-webhook] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Count recent bounces for this contact's KOL and, if threshold met, set
// kols.email_blocked_at so future sends short-circuit. Default threshold: 2
// hard bounces (any provider-level bounce event). Env-tunable.
const HARD_BOUNCE_BLOCK_THRESHOLD = parseInt(process.env.HARD_BOUNCE_BLOCK_THRESHOLD) || 2;
async function maybeBlockKol(contactId, reason, opts = {}) {
  if (!contactId) return;
  try {
    const row = await queryOne(
      `SELECT c.kol_id, k.email_blocked_at FROM contacts c JOIN kols k ON c.kol_id = k.id WHERE c.id = ?`,
      [contactId]
    );
    if (!row || row.email_blocked_at) return; // already blocked, noop
    const threshold = opts.threshold || HARD_BOUNCE_BLOCK_THRESHOLD;
    // Count bounce/failed events for this KOL's contacts over all time.
    // "Over all time" is appropriate: if this address bounced twice ever,
    // it's effectively dead — no point re-sending after a cooldown.
    const countRow = await queryOne(
      `SELECT COUNT(*) as n
       FROM email_events e
       JOIN contacts c2 ON c2.id = e.contact_id
       WHERE c2.kol_id = ? AND e.event_type IN ('bounced', 'complained', 'failed')`,
      [row.kol_id]
    );
    const count = parseInt(countRow?.n || 0);
    if (count >= threshold) {
      await exec(
        `UPDATE kols SET email_blocked_at = CURRENT_TIMESTAMP, email_blocked_reason = ? WHERE id = ?`,
        [String(reason).slice(0, 200), row.kol_id]
      );
      console.log(`[hard-bounce] Blocked KOL ${row.kol_id} after ${count} bounce/complaint events: ${reason}`);
    }
  } catch (e) {
    console.warn('[hard-bounce] failed to evaluate block:', e.message);
  }
}

// Manually clear the block on a KOL's email (e.g., after confirming with
// the creator that the bounce was transient).
app.post(`${BASE_PATH}/api/kols/:id/unblock-email`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      `UPDATE kols SET email_blocked_at = NULL, email_blocked_reason = NULL WHERE id = ? AND workspace_id = ?`,
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'KOL not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get email thread + event timeline for a contact
app.get(`${BASE_PATH}/api/contacts/:id/thread`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const contact = await s.queryOne(
      `SELECT c.*, k.display_name as kol_name, k.username, k.email as kol_email, k.platform, k.avatar_url
       FROM contacts c LEFT JOIN kols k ON c.kol_id=k.id
       WHERE c.id=? AND c.workspace_id=?`,
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Surface variant attribution so the thread can label "sent using variant B"
    let variantInfo = null;
    if (contact.template_id || contact.variant_id) {
      const templateRow = await s.queryOne(
        'SELECT id, name FROM email_templates WHERE id = ? AND workspace_id = ?',
        [contact.template_id, req.workspace.id]
      );
      let variantRow = null;
      if (contact.variant_id) {
        variantRow = await s.queryOne(
          'SELECT id, name, variant_label FROM email_templates WHERE id = ? AND workspace_id = ?',
          [contact.variant_id, req.workspace.id]
        );
      }
      variantInfo = {
        template_id: contact.template_id,
        template_name: templateRow?.name || null,
        variant_id: contact.variant_id || null,
        variant_label: variantRow?.variant_label || (contact.template_id && !contact.variant_id ? 'control' : null),
      };
    }
    contact.variant_info = variantInfo;

    const replies = await s.query(
      `SELECT * FROM email_replies
       WHERE contact_id=? AND workspace_id=?
       ORDER BY received_at ASC`,
      [req.params.id, req.workspace.id]
    );

    const events = await s.query(
      `SELECT id, event_type, payload, occurred_at
       FROM email_events WHERE contact_id=? AND workspace_id=?
       ORDER BY occurred_at ASC`,
      [req.params.id, req.workspace.id]
    );

    const thread = [];
    const hasRealOutbound = (replies.rows || []).some(r => r.direction === 'outbound');

    // Synthesize a placeholder from contacts.email_body only when there is no
    // persisted outbound row (older contacts sent before email_replies was
    // populated, or drafts that were never actually sent).
    if (!hasRealOutbound && contact.email_subject) {
      thread.push({
        id: 'outbound-' + contact.id,
        direction: 'outbound',
        from_email: 'contact@market.hakko.ai',
        to_email: contact.kol_email || '',
        subject: contact.email_subject,
        body_text: contact.email_body,
        sent_at: contact.sent_at,
      });
    }

    for (const r of replies.rows) {
      thread.push({
        id: r.id,
        direction: r.direction,
        from_email: r.from_email,
        to_email: r.to_email,
        subject: r.subject,
        body_text: r.body_text,
        sent_at: r.received_at,
      });
    }

    const timeline = (events.rows || []).map(e => {
      let payload = {};
      try { payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; } catch {}
      return {
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        payload,
      };
    });

    res.json({ contact, thread, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get email thread for a pipeline job
app.get(`${BASE_PATH}/api/pipeline/jobs/:id/thread`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const job = await s.queryOne(
      "SELECT * FROM pipeline_jobs WHERE id=? AND workspace_id=?",
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const replies = await s.query(
      "SELECT * FROM email_replies WHERE pipeline_job_id=? AND workspace_id=? ORDER BY received_at ASC",
      [req.params.id, req.workspace.id]
    );

    const thread = [];
    if (job.email_subject && job.email_sent_at) {
      thread.push({
        id: 'outbound-' + job.id,
        direction: 'outbound',
        from_email: 'contact@market.hakko.ai',
        to_email: job.email_to || '',
        subject: job.email_subject,
        body_text: job.email_body,
        sent_at: job.email_sent_at,
      });
    }
    for (const r of replies.rows) {
      thread.push({
        id: r.id,
        direction: r.direction,
        from_email: r.from_email,
        to_email: r.to_email,
        subject: r.subject,
        body_text: r.body_text,
        sent_at: r.received_at,
      });
    }

    res.json({ job, thread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch generate emails for all approved KOLs in a campaign
app.post(`${BASE_PATH}/api/campaigns/:campaignId/contacts/batch-generate`, async (req, res) => {
  try {
    const { cooperation_type, price_quote } = req.body;
    const workspaceId = req.workspace.id;
    const campaign = await queryOne('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [req.params.campaignId, workspaceId]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const approvedResult = await query(
      "SELECT * FROM kols WHERE campaign_id = ? AND workspace_id = ? AND status = 'approved'",
      [req.params.campaignId, workspaceId]
    );
    const approvedKols = approvedResult.rows;

    // Filter out KOLs that already have contacts
    const existingResult = await query(
      'SELECT kol_id FROM contacts WHERE campaign_id = ? AND workspace_id = ?',
      [req.params.campaignId, workspaceId]
    );
    const existingKolIds = existingResult.rows.map(r => r.kol_id);
    const newKols = approvedKols.filter(k => !existingKolIds.includes(k.id));

    const results = await transaction(async (tx) => {
      const txResults = [];
      for (const kol of newKols) {
        const email = await generateOutreachEmail(kol, campaign, cooperation_type || 'affiliate', price_quote);
        const id = uuidv4();
        await tx.exec(
          'INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, price_quote, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, workspaceId, kol.id, req.params.campaignId, email.subject, email.body, cooperation_type || 'affiliate', price_quote || '', 'draft']
        );
        txResults.push({ id, kol_id: kol.id, ...email });
      }
      return txResults;
    });
    res.json({ generated: results.length, contacts: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Data API ====================

// Get content performance data
app.get(`${BASE_PATH}/api/data/content`, async (req, res) => {
  try {
    const result = await query('SELECT * FROM content_data ORDER BY publish_date DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add/update content data (manual or from Feishu sync)
app.post(`${BASE_PATH}/api/data/content`, async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (usePostgres) {
      await transaction(async (tx) => {
        for (const item of items) {
          await tx.exec(
            'INSERT INTO content_data (id, kol_name, platform, content_title, content_url, publish_date, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kol_name=EXCLUDED.kol_name, platform=EXCLUDED.platform, content_title=EXCLUDED.content_title, content_url=EXCLUDED.content_url, publish_date=EXCLUDED.publish_date, views=EXCLUDED.views, likes=EXCLUDED.likes, comments=EXCLUDED.comments, shares=EXCLUDED.shares',
            [item.id || uuidv4(), item.kol_name, item.platform, item.content_title, item.content_url || '', item.publish_date, item.views || 0, item.likes || 0, item.comments || 0, item.shares || 0]
          );
        }
      });
    } else {
      await transaction(async (tx) => {
        for (const item of items) {
          await tx.exec(
            'INSERT OR REPLACE INTO content_data (id, kol_name, platform, content_title, content_url, publish_date, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [item.id || uuidv4(), item.kol_name, item.platform, item.content_title, item.content_url || '', item.publish_date, item.views || 0, item.likes || 0, item.comments || 0, item.shares || 0]
          );
        }
      });
    }
    res.json({ success: true, count: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get registration data
app.get(`${BASE_PATH}/api/data/registrations`, async (req, res) => {
  try {
    const result = await query('SELECT * FROM registration_data ORDER BY date ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add/update registration data
app.post(`${BASE_PATH}/api/data/registrations`, async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (usePostgres) {
      await transaction(async (tx) => {
        for (const item of items) {
          await tx.exec(
            'INSERT INTO registration_data (id, date, registrations, source) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET date=EXCLUDED.date, registrations=EXCLUDED.registrations, source=EXCLUDED.source',
            [item.id || uuidv4(), item.date, item.registrations || 0, item.source || '']
          );
        }
      });
    } else {
      await transaction(async (tx) => {
        for (const item of items) {
          await tx.exec(
            'INSERT OR REPLACE INTO registration_data (id, date, registrations, source) VALUES (?, ?, ?, ?)',
            [item.id || uuidv4(), item.date, item.registrations || 0, item.source || '']
          );
        }
      });
    }
    res.json({ success: true, count: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Seed demo data
app.post(`${BASE_PATH}/api/data/seed-demo`, async (req, res) => {
  try {
    await seedDemoData();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== KOL Database API ====================

// KOL scraper API status (must be before /:id route)
app.get(`${BASE_PATH}/api/kol-database/api-status`, (req, res) => {
  res.json(scraper.getApiStatus());
});

// YouTube API daily quota status
app.get(`${BASE_PATH}/api/quota/youtube`, (req, res) => {
  res.json(youtubeQuota.status());
});

// Apify daily quota status (covers IG + TikTok actor calls)
app.get(`${BASE_PATH}/api/quota/apify`, (req, res) => {
  res.json(apifyQuota.status());
});

// Discovery platform availability — tells the UI which platform checkboxes
// are usable so it can disable + label the rest. Computed from the same
// env-var checks the discovery worker uses, so this is the source of truth.
app.get(`${BASE_PATH}/api/discovery/platforms`, (req, res) => {
  res.json({
    platforms: [
      { id: 'youtube', configured: !!process.env.YOUTUBE_API_KEY, requires: 'YOUTUBE_API_KEY' },
      { id: 'instagram', configured: apify.isConfigured(), requires: 'APIFY_TOKEN' },
      { id: 'tiktok', configured: apify.isConfigured(), requires: 'APIFY_TOKEN' },
    ],
  });
});

// ==================== RBAC ====================

// Return current user's effective permissions (for UI gating)
app.get(`${BASE_PATH}/api/auth/permissions`, authMiddleware, (req, res) => {
  const role = req.user?.role || 'viewer';
  res.json({ role, permissions: rbac.getRolePermissions(role) });
});

// List all roles (for admin UI)
app.get(`${BASE_PATH}/api/auth/roles`, (req, res) => {
  res.json({ roles: rbac.ROLES });
});

// ==================== User Management (admin only) ====================

// List all users
app.get(`${BASE_PATH}/api/users`, authMiddleware, rbac.requirePermission('user.manage'), async (req, res) => {
  try {
    const result = await query('SELECT id, email, name, role, avatar_url, created_at, last_login FROM users ORDER BY created_at DESC');
    res.json(result.rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Invite (create) a new user with a temporary password
app.post(`${BASE_PATH}/api/users/invite`, authMiddleware, rbac.requirePermission('user.invite'), async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name, and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const safeRole = rbac.ROLES.includes(role) ? role : 'editor';
    const result = await registerUser(email, password, name);
    if (result.error) return res.status(400).json({ error: result.error });
    if (safeRole !== 'editor' && safeRole !== 'member') {
      await exec('UPDATE users SET role=? WHERE id=?', [safeRole, result.id]);
    }
    res.json({ success: true, user: { ...result, role: safeRole } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a user's role
app.patch(`${BASE_PATH}/api/users/:id/role`, authMiddleware, rbac.requirePermission('user.manage'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!rbac.ROLES.includes(role) && role !== 'member') {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${rbac.ROLES.join(', ')}` });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    await exec('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a user
app.delete(`${BASE_PATH}/api/users/:id`, authMiddleware, rbac.requirePermission('user.delete'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await exec('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
    await exec('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== CSV Export ====================

function sendCsv(res, rows, columns, filename) {
  const csv = csvExport.toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// Export campaign KOLs to CSV
app.get(`${BASE_PATH}/api/campaigns/:id/kols/export`, exportLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const campaign = await s.queryOne(
      'SELECT name FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const result = await s.query(
      'SELECT * FROM kols WHERE campaign_id = ? AND workspace_id = ? ORDER BY ai_score DESC',
      [req.params.id, req.workspace.id]
    );
    const safeName = (campaign.name || 'campaign').replace(/[^a-z0-9_-]/gi, '_');
    sendCsv(res, result.rows || [], csvExport.COLUMNS.kols, `kols-${safeName}.csv`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export campaign contacts to CSV
app.get(`${BASE_PATH}/api/campaigns/:id/contacts/export`, exportLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const campaign = await s.queryOne(
      'SELECT name FROM campaigns WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const result = await s.query(
      `SELECT c.*, k.display_name, k.username, k.platform, k.email as kol_email
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.workspace_id = ? AND c.campaign_id = ?
       ORDER BY c.created_at DESC`,
      [req.workspace.id, req.params.id]
    );
    const safeName = (campaign.name || 'campaign').replace(/[^a-z0-9_-]/gi, '_');
    sendCsv(res, result.rows || [], csvExport.COLUMNS.contacts, `contacts-${safeName}.csv`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export the global KOL database to CSV
app.get(`${BASE_PATH}/api/kol-database/export`, exportLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT * FROM kol_database WHERE workspace_id = ? ORDER BY ai_score DESC, followers DESC',
      [req.workspace.id]
    );
    sendCsv(res, result.rows || [], csvExport.COLUMNS.kols, `kol-database.csv`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export all content data to CSV
app.get(`${BASE_PATH}/api/data/content/export`, exportLimiter, async (req, res) => {
  try {
    const result = await query('SELECT * FROM content_data ORDER BY publish_date DESC');
    sendCsv(res, result.rows || [], csvExport.COLUMNS.content, 'content-data.csv');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Scheduler ====================

// Schedule a contact email for future send
app.post(`${BASE_PATH}/api/contacts/:id/schedule`, async (req, res) => {
  try {
    const { scheduled_send_at } = req.body;
    if (!scheduled_send_at) return res.status(400).json({ error: 'scheduled_send_at required (ISO 8601)' });
    const when = new Date(scheduled_send_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid date format' });
    if (when < new Date()) return res.status(400).json({ error: 'Scheduled time must be in the future' });
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'UPDATE contacts SET scheduled_send_at = ? WHERE id = ? AND workspace_id = ?',
      [when.toISOString(), req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, scheduled_send_at: when.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel a scheduled send
app.delete(`${BASE_PATH}/api/contacts/:id/schedule`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'UPDATE contacts SET scheduled_send_at = NULL WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually trigger a scheduler tick (useful for testing / admin)
app.post(`${BASE_PATH}/api/scheduler/tick`, authMiddleware, rbac.requirePermission('system.manage'), async (req, res) => {
  try {
    const result = await scheduler.tick({ query, exec, queryOne, mailAgent, uuidv4, jobQueue });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Agent Runtime API (Phase A Week 2) ====================

// List all registered agents
app.get(`${BASE_PATH}/api/agents`, (req, res) => {
  res.json({ agents: agentRuntime.listAgents() });
});

// NOTE: Fixed-path routes (/cost, /runs, /runs/:id/stream) must come BEFORE
// the generic /:id route, otherwise Express matches 'cost' / 'runs' as
// agent IDs.

// Cost summary for the current workspace
app.get(`${BASE_PATH}/api/agents/cost`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    // Portable "today" window: compare as ISO strings. Works on both
    // PG (timestamp) and SQLite (text) since ISO strings sort lexically.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const dayStartStr = dayStart.toISOString();
    const dayEndStr = dayEnd.toISOString();
    const [all, todayRow, byAgent] = await Promise.all([
      s.queryOne('SELECT COUNT(*) as runs, COALESCE(SUM(cost_usd_cents),0) as cents, COALESCE(SUM(input_tokens),0) as in_t, COALESCE(SUM(output_tokens),0) as out_t FROM agent_runs WHERE workspace_id = ?', [req.workspace.id]),
      s.queryOne(`SELECT COUNT(*) as runs, COALESCE(SUM(cost_usd_cents),0) as cents FROM agent_runs WHERE workspace_id = ? AND started_at >= ? AND started_at < ?`, [req.workspace.id, dayStartStr, dayEndStr]),
      s.query('SELECT agent_id, COUNT(*) as runs, COALESCE(SUM(cost_usd_cents),0) as cents FROM agent_runs WHERE workspace_id = ? GROUP BY agent_id ORDER BY cents DESC', [req.workspace.id]),
    ]);
    res.json({
      lifetime: { runs: parseInt(all.runs) || 0, usdCents: parseInt(all.cents) || 0, inputTokens: parseInt(all.in_t) || 0, outputTokens: parseInt(all.out_t) || 0 },
      today: { runs: parseInt(todayRow.runs) || 0, usdCents: parseInt(todayRow.cents) || 0 },
      byAgent: (byAgent.rows || []).map(r => ({ agent_id: r.agent_id, runs: parseInt(r.runs), usdCents: parseInt(r.cents) })),
      llmStats: llm.getStats(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List agent runs (fixed path before /:id)
app.get(`${BASE_PATH}/api/agents/runs`, async (req, res) => {
  try {
    const { agent_id, status, limit } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT id, agent_id, user_id, status, cost_usd_cents, input_tokens, output_tokens, duration_ms, started_at, completed_at FROM agent_runs WHERE workspace_id = ?';
    const params = [req.workspace.id];
    if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 50, 200));
    const result = await s.query(sql, params);
    res.json({ runs: result.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single run with its traces
app.get(`${BASE_PATH}/api/agents/runs/:runId`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const run = await s.queryOne('SELECT * FROM agent_runs WHERE id = ? AND workspace_id = ?', [req.params.runId, req.workspace.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const traces = await query('SELECT event_type, data, timestamp FROM agent_traces WHERE run_id = ? ORDER BY timestamp ASC', [req.params.runId]);
    run.input = run.input ? JSON.parse(run.input) : null;
    run.output = run.output ? JSON.parse(run.output) : null;
    run.traces = (traces.rows || []).map(t => ({ ...t, data: JSON.parse(t.data || '{}') }));
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single agent's metadata — generic /:id MUST come last
app.get(`${BASE_PATH}/api/agents/:id`, (req, res) => {
  const agent = agentRuntime.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Run an agent. Returns { runId } immediately; use streamAgentRun for events.
app.post(`${BASE_PATH}/api/agents/:id/run`, async (req, res) => {
  try {
    const agent = agentRuntime.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Persist the run row now so the client can look it up
    const estimate = agentRuntime.estimateCost(req.params.id, req.body) || {};
    const { runId, stream } = agentRuntime.createRun(req.params.id, req.body, {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      db: { query, queryOne, exec },
      uuidv4,
    });

    const wsId = req.workspace?.id || null;

    // Attach listener FIRST (synchronously) before any awaits, so fast
    // synchronous agents don't emit started/progress/complete before we're
    // listening. The DB insert then happens in the background.
    stream.on('event', async (evt) => {
      try {
        await exec(
          'INSERT INTO agent_traces (id, run_id, event_type, data) VALUES (?, ?, ?, ?)',
          [uuidv4(), runId, evt.type, JSON.stringify(evt.data || {})]
        );
        if (evt.type === 'complete') {
          const cost = evt.data?.cost || {};
          await exec(
            `UPDATE agent_runs SET status=?, output=?, cost_usd_cents=?, input_tokens=?, output_tokens=?, duration_ms=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
            [
              'complete',
              JSON.stringify(evt.data.output || {}),
              cost.usdCents || 0,
              cost.inputTokens || 0,
              cost.outputTokens || 0,
              evt.data.durationMs || null,
              runId,
            ]
          );
        } else if (evt.type === 'error') {
          await exec(
            "UPDATE agent_runs SET status='error', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
            [evt.data?.message || 'unknown', runId]
          );
        }
      } catch (persistErr) {
        console.warn('[agent-run] Trace persistence error:', persistErr.message);
      }
    });

    // Persist the agent_runs row. This can happen asynchronously (we don't
    // block the HTTP response on it), but we do block the response so the
    // client gets a valid runId that will exist when they poll.
    await exec(
      'INSERT INTO agent_runs (id, workspace_id, agent_id, user_id, input, status, cost_usd_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [runId, wsId, req.params.id, req.user?.id || null, JSON.stringify(req.body || {}), 'running', estimate.usdCents || 0]
    );

    res.json({ runId, status: 'running', estimate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE stream of events for a running agent.
// Auth via query string token + workspace_id since EventSource can't set headers.
app.get(`${BASE_PATH}/api/agents/runs/:runId/stream`, async (req, res) => {
  try {
    // Manual auth from query string (EventSource limitation)
    const token = req.query.token;
    const user = token ? await getSession(token) : null;
    if (!user) return res.status(401).end();

    // Check the run belongs to this user's workspace
    const wsId = req.query.workspace_id;
    const run = await queryOne('SELECT workspace_id, agent_id, status FROM agent_runs WHERE id = ?', [req.params.runId]);
    if (!run) return res.status(404).end();
    if (wsId && run.workspace_id !== wsId) return res.status(403).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const stream = agentRuntime.getRunStream(req.params.runId);
    if (!stream) {
      // Run already finished — replay traces from DB
      const traces = await query('SELECT event_type, data, timestamp FROM agent_traces WHERE run_id = ? ORDER BY timestamp ASC', [req.params.runId]);
      for (const t of traces.rows || []) {
        res.write(`event: ${t.event_type}\ndata: ${JSON.stringify({ data: JSON.parse(t.data || '{}'), timestamp: t.timestamp })}\n\n`);
      }
      res.write(`event: closed\ndata: {}\n\n`);
      return res.end();
    }

    const listener = (evt) => {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      if (evt.type === 'closed' || evt.type === 'complete' || evt.type === 'error') {
        setTimeout(() => { try { res.end(); } catch {} }, 50);
      }
    };
    stream.on('event', listener);

    req.on('close', () => {
      stream.off('event', listener);
    });
  } catch (e) {
    console.error('[agent stream]', e);
    try { res.status(500).end(); } catch {}
  }
});

// (duplicate handlers removed — see reordered block above)

// ==================== Content Pieces (saved agent outputs) ====================

app.get(`${BASE_PATH}/api/content/pieces`, async (req, res) => {
  try {
    const { type, status, limit } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT * FROM content_pieces WHERE workspace_id = ?';
    const params = [req.workspace.id];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 50, 200));
    const result = await s.query(sql, params);
    const pieces = (result.rows || []).map(p => ({
      ...p,
      metadata: p.metadata ? JSON.parse(p.metadata) : {},
    }));
    res.json({ pieces });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/content/pieces`, async (req, res) => {
  try {
    const { type, title, body, metadata, status, created_by_agent_run_id } = req.body;
    if (!title && !body) return res.status(400).json({ error: 'title or body required' });
    const id = uuidv4();
    const s = scoped(req.workspace.id);
    await s.exec(
      'INSERT INTO content_pieces (id, workspace_id, type, title, body, metadata, status, created_by_agent_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, type || 'text', title || '', body || '', JSON.stringify(metadata || {}), status || 'draft', created_by_agent_run_id || null]
    );
    res.json({ id, type, title, body, status: status || 'draft' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch(`${BASE_PATH}/api/content/pieces/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const updates = [];
    const params = [];
    for (const field of ['title', 'body', 'status', 'type']) {
      if (req.body[field] !== undefined) { updates.push(`${field} = ?`); params.push(req.body[field]); }
    }
    if (req.body.metadata !== undefined) { updates.push('metadata = ?'); params.push(JSON.stringify(req.body.metadata)); }
    if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id, req.workspace.id);
    const result = await s.exec(
      `UPDATE content_pieces SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${BASE_PATH}/api/content/pieces/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'DELETE FROM content_pieces WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy-fetch a remote URL and return its bytes as a data URL. Used by
// Content Studio to persist generated images before their source URLs
// expire. Basic SSRF guards: HTTPS only, no private IPs, 10MB cap.
app.post(`${BASE_PATH}/api/util/fetch-as-data-url`, async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'Only HTTPS URLs accepted' });
    // Block anything that looks like a private / metadata host
    try {
      const host = new URL(url).hostname;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'localhost' || host.endsWith('.internal')) {
        return res.status(400).json({ error: 'URL points to a blocked host range' });
      }
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const fetch = require('./proxy-fetch');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let r;
    try {
      r = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });

    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    // 10 MB hard cap
    const lengthHeader = parseInt(r.headers.get('content-length') || '0');
    if (lengthHeader > 10 * 1024 * 1024) return res.status(413).json({ error: 'Content too large (>10MB)' });

    const arr = await r.arrayBuffer();
    if (arr.byteLength > 10 * 1024 * 1024) return res.status(413).json({ error: 'Content too large (>10MB)' });

    const buf = Buffer.from(arr);
    res.json({
      data_url: `data:${contentType};base64,${buf.toString('base64')}`,
      byte_size: buf.length,
      content_type: contentType,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Platform OAuth Connections ====================

const publishOauth = require('./publish/oauth');
const { encrypt: encryptSecret } = require('./encryption');

// List available platforms + their configured/connected state for this workspace
app.get(`${BASE_PATH}/api/publish/platforms`, async (req, res) => {
  try {
    const providers = publishOauth.listProviders();
    const s = scoped(req.workspace.id);
    const existing = await s.query(
      'SELECT platform, account_name, account_id, connected_at, expires_at FROM platform_connections WHERE workspace_id = ?',
      [req.workspace.id]
    );
    const connectedMap = {};
    for (const row of existing.rows || []) connectedMap[row.platform] = row;

    res.json({
      platforms: providers.map(p => ({
        ...p,
        connection: connectedMap[p.id] || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Begin OAuth flow — returns the authorize URL; caller opens it in a new tab
app.post(`${BASE_PATH}/api/publish/oauth/:provider/init`, async (req, res) => {
  try {
    const provider = req.params.provider;
    if (!publishOauth.getProvider(provider)) return res.status(404).json({ error: 'Unknown provider' });
    if (!publishOauth.isConfigured(provider)) {
      return res.status(400).json({ error: `${provider} OAuth not configured on this deployment (missing client credentials env vars)` });
    }
    const { url, state, codeVerifier, redirect } = publishOauth.buildAuthorizeUrl(provider, {
      workspaceId: req.workspace.id,
      userId: req.user.id,
    });
    await exec(
      'INSERT INTO oauth_states (state, workspace_id, user_id, platform, code_verifier) VALUES (?, ?, ?, ?, ?)',
      [state, req.workspace.id, req.user.id, provider, codeVerifier || null]
    );
    res.json({ authorize_url: url, state, redirect_uri: redirect });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OAuth callback — the provider redirects here after user approves.
// Exchanges code for tokens and stores in platform_connections.
app.get(`${BASE_PATH}/api/publish/oauth/:provider/callback`, async (req, res) => {
  try {
    const provider = req.params.provider;
    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).send(`<html><body><h2>OAuth error</h2><p>${error}</p><p><a href="/workspace/settings">Back</a></p></body></html>`);
    }
    if (!code || !state) return res.status(400).send('missing code/state');

    const row = await queryOne('SELECT * FROM oauth_states WHERE state = ?', [state]);
    if (!row) return res.status(400).send('state mismatch or expired');
    if (row.platform !== provider) return res.status(400).send('platform mismatch');

    const redirect = `${process.env.OAUTH_CALLBACK_BASE || 'https://influencexes.com'}/api/publish/oauth/${provider}/callback`;
    const tokenInfo = await publishOauth.exchangeCodeForToken(provider, {
      code,
      redirectUri: redirect,
      codeVerifier: row.code_verifier,
    });

    // Upsert into platform_connections
    const existingConn = await queryOne(
      'SELECT id FROM platform_connections WHERE workspace_id = ? AND platform = ?',
      [row.workspace_id, provider]
    );
    const expiresAt = tokenInfo.expires_in ? new Date(Date.now() + tokenInfo.expires_in * 1000).toISOString() : null;

    // Providers that carry a `encryptTokens: true` flag (currently gmail) get
    // their access_token + refresh_token encrypted at rest. Other providers
    // continue to store plaintext — intentional: migrating every existing row
    // is a separate change, and mixing encrypted/plaintext is safe because
    // decrypt() passes plaintext through via the enc: prefix check.
    const providerMeta = publishOauth.getProvider(provider);
    const maybeEncrypt = providerMeta?.encryptTokens ? encryptSecret : (v => v);

    if (existingConn) {
      await exec(
        'UPDATE platform_connections SET access_token=?, refresh_token=?, token_scope=?, expires_at=?, account_name=?, account_id=?, connected_at=CURRENT_TIMESTAMP WHERE id=?',
        [maybeEncrypt(tokenInfo.access_token), maybeEncrypt(tokenInfo.refresh_token), tokenInfo.scope, expiresAt, tokenInfo.account_name, tokenInfo.account_id, existingConn.id]
      );
    } else {
      await exec(
        'INSERT INTO platform_connections (id, workspace_id, platform, account_name, account_id, access_token, refresh_token, token_scope, expires_at, connected_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), row.workspace_id, provider, tokenInfo.account_name, tokenInfo.account_id, maybeEncrypt(tokenInfo.access_token), maybeEncrypt(tokenInfo.refresh_token), tokenInfo.scope, expiresAt, row.user_id]
      );
    }

    await exec('DELETE FROM oauth_states WHERE state = ?', [state]);

    // Small HTML page that closes the popup / shows success
    res.send(`<!DOCTYPE html><html><head><title>Connected</title><style>body{font-family:sans-serif;background:#0a0a0f;color:#f0f0f5;padding:48px;text-align:center}</style></head><body><h1>✅ Connected to ${provider}</h1><p>as ${tokenInfo.account_name || '(account)'}<p>You can close this window.</p><script>setTimeout(() => window.close(), 1500);</script></body></html>`);
  } catch (e) {
    res.status(500).send(`<html><body><h2>OAuth callback failed</h2><pre>${String(e.message || e).slice(0, 500)}</pre></body></html>`);
  }
});

// API-key connect — for Medium / Ghost / WordPress (non-OAuth platforms).
// Body: { fields: { <field_name>: value, ... } } matching provider.fields
app.post(`${BASE_PATH}/api/publish/connect/:platform`, async (req, res) => {
  try {
    const platform = req.params.platform;
    const provider = publishOauth.getProvider(platform);
    if (!provider) return res.status(404).json({ error: 'Unknown platform' });
    if (provider.kind !== 'api_key') return res.status(400).json({ error: 'Use OAuth init endpoint for this platform' });

    const { fields } = req.body || {};
    if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields object is required' });

    // Validate required fields are present
    for (const f of provider.fields) {
      if (!fields[f.name] || String(fields[f.name]).trim() === '') {
        return res.status(400).json({ error: `Missing field: ${f.name}` });
      }
    }

    // Account label for the UI — best-effort.
    let accountName = fields.site_url || fields.username || fields.integration_token?.slice(0, 8) || platform;
    try { if (fields.site_url) accountName = new URL(fields.site_url).hostname; } catch {}

    const existing = await queryOne(
      'SELECT id FROM platform_connections WHERE workspace_id = ? AND platform = ?',
      [req.workspace.id, platform]
    );
    const metadata = JSON.stringify(fields);
    if (existing) {
      await exec(
        'UPDATE platform_connections SET account_name=?, metadata=?, connected_at=CURRENT_TIMESTAMP, connected_by=? WHERE id=?',
        [accountName, metadata, req.user.id, existing.id]
      );
    } else {
      await exec(
        'INSERT INTO platform_connections (id, workspace_id, platform, account_name, metadata, connected_by) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), req.workspace.id, platform, accountName, metadata, req.user.id]
      );
    }
    res.json({ success: true, account_name: accountName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${BASE_PATH}/api/publish/platforms/:platform`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const r = await s.exec(
      'DELETE FROM platform_connections WHERE workspace_id = ? AND platform = ?',
      [req.workspace.id, req.params.platform]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not connected' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Direct publish: uses stored platform connection to post for real
app.post(`${BASE_PATH}/api/publish/direct/:platform`, async (req, res) => {
  try {
    const platform = req.params.platform;
    const { text, image_url, title, tags } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const s = scoped(req.workspace.id);
    const conn = await s.queryOne(
      'SELECT * FROM platform_connections WHERE workspace_id = ? AND platform = ?',
      [req.workspace.id, platform]
    );
    if (!conn) return res.status(400).json({ error: `${platform} not connected for this workspace` });

    const provider = publishOauth.getProvider(platform);
    // API-key platforms store their creds JSON in metadata; OAuth platforms use access_token.
    const credentials = provider?.kind === 'api_key'
      ? (() => { try { return JSON.parse(conn.metadata || '{}'); } catch { return {}; } })()
      : conn.access_token;
    const result = await publishOauth.publishDirect(platform, credentials, { text, title, tags, imageUrl: image_url });

    await exec(
      'UPDATE platform_connections SET last_used_at=CURRENT_TIMESTAMP WHERE id=?',
      [conn.id]
    );

    if (!result.success) {
      return res.status(502).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Make callback path skip workspace middleware (it has its own state validation)
// We also need it to skip auth — which it already does since it's a GET and auth
// only applies via req.headers. The state table validates authenticity.
// But our lenient workspace middleware would 401 without auth. Fix:
// callback path bypasses the workspace middleware in the skip list.

// ==================== Scheduled Publishes ====================

app.get(`${BASE_PATH}/api/scheduled-publishes`, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT * FROM scheduled_publishes WHERE workspace_id = ?';
    const params = [req.workspace.id];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY scheduled_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 100, 500));
    const result = await s.query(sql, params);
    const items = (result.rows || []).map(r => ({
      ...r,
      platforms: r.platforms ? JSON.parse(r.platforms) : [],
      content_snapshot: r.content_snapshot ? JSON.parse(r.content_snapshot) : {},
      result: r.result ? JSON.parse(r.result) : null,
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/scheduled-publishes`, async (req, res) => {
  try {
    const { content_piece_id, platforms, scheduled_at, mode, content } = req.body;
    if (!Array.isArray(platforms) || platforms.length === 0) return res.status(400).json({ error: 'platforms[] is required' });
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required (ISO)' });
    const when = new Date(scheduled_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid scheduled_at' });

    const s = scoped(req.workspace.id);
    let snapshot = content || null;
    if (!snapshot && content_piece_id) {
      const piece = await s.queryOne('SELECT * FROM content_pieces WHERE id = ? AND workspace_id = ?', [content_piece_id, req.workspace.id]);
      if (!piece) return res.status(404).json({ error: 'content_piece not found in this workspace' });
      snapshot = {
        title: piece.title,
        body: piece.body,
        type: piece.type,
        metadata: piece.metadata ? JSON.parse(piece.metadata) : {},
      };
    }
    if (!snapshot) return res.status(400).json({ error: 'Provide either content_piece_id or inline content' });

    const id = uuidv4();
    await s.exec(
      'INSERT INTO scheduled_publishes (id, workspace_id, content_piece_id, platforms, content_snapshot, scheduled_at, mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, content_piece_id || null, JSON.stringify(platforms), JSON.stringify(snapshot), when.toISOString(), mode || 'intent', req.user?.id || null]
    );
    res.json({ id, scheduled_at: when.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${BASE_PATH}/api/scheduled-publishes/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const r = await s.exec(
      "UPDATE scheduled_publishes SET status='cancelled' WHERE id = ? AND workspace_id = ? AND status = 'pending'",
      [req.params.id, req.workspace.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found or not cancellable' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger for admin — processes all due pending items now
app.post(`${BASE_PATH}/api/scheduled-publishes/tick`, authMiddleware, rbac.requirePermission('system.manage'), async (req, res) => {
  try {
    const result = await scheduledPublish.processDue({
      query, queryOne, exec, uuidv4, publishOauth, agentRuntime,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Analytics ====================

// Preset effectiveness — usage + derived pieces + cost per-preset
app.get(`${BASE_PATH}/api/analytics/presets`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const presets = await s.query(
      'SELECT id, name, type, agent_id, use_count, created_at FROM prompt_presets WHERE workspace_id = ? ORDER BY use_count DESC, created_at DESC',
      [req.workspace.id]
    );
    res.json({ presets: presets.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Platform performance from scheduled_publishes — count per status per platform
app.get(`${BASE_PATH}/api/analytics/platforms`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT platforms, status FROM scheduled_publishes WHERE workspace_id = ?',
      [req.workspace.id]
    );
    // Aggregate JS-side (platforms is a JSON array, not directly queryable portably)
    const perPlatform = {};
    for (const row of result.rows || []) {
      let list = [];
      try { list = JSON.parse(row.platforms); } catch {}
      for (const p of list) {
        perPlatform[p] = perPlatform[p] || { complete: 0, error: 0, pending: 0, cancelled: 0, running: 0 };
        perPlatform[p][row.status] = (perPlatform[p][row.status] || 0) + 1;
      }
    }
    const byPlatform = Object.entries(perPlatform).map(([platform, counts]) => ({
      platform,
      ...counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      successRate: counts.complete / Math.max(1, Object.values(counts).reduce((a, b) => a + b, 0)),
    }));
    res.json({ byPlatform });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agent performance — breakdown of runs, cost, avg duration, error rate
app.get(`${BASE_PATH}/api/analytics/agents`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      `SELECT agent_id,
              COUNT(*) as total_runs,
              SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete_runs,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_runs,
              COALESCE(SUM(cost_usd_cents), 0) as total_cents,
              COALESCE(SUM(input_tokens), 0) as input_tokens,
              COALESCE(SUM(output_tokens), 0) as output_tokens,
              COALESCE(AVG(duration_ms), 0) as avg_duration_ms
       FROM agent_runs
       WHERE workspace_id = ?
       GROUP BY agent_id
       ORDER BY total_runs DESC`,
      [req.workspace.id]
    );
    const byAgent = (result.rows || []).map(r => ({
      agent_id: r.agent_id,
      total_runs: parseInt(r.total_runs) || 0,
      complete_runs: parseInt(r.complete_runs) || 0,
      error_runs: parseInt(r.error_runs) || 0,
      total_usd_cents: parseInt(r.total_cents) || 0,
      input_tokens: parseInt(r.input_tokens) || 0,
      output_tokens: parseInt(r.output_tokens) || 0,
      avg_duration_ms: Math.round(parseFloat(r.avg_duration_ms) || 0),
      success_rate: r.total_runs > 0 ? parseInt(r.complete_runs) / parseInt(r.total_runs) : 0,
    }));
    res.json({ byAgent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Content library breakdown — pieces per type, per status
app.get(`${BASE_PATH}/api/analytics/content`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      `SELECT type, status, COUNT(*) as c FROM content_pieces WHERE workspace_id = ? GROUP BY type, status`,
      [req.workspace.id]
    );
    const byType = {};
    for (const r of result.rows || []) {
      byType[r.type] = byType[r.type] || {};
      byType[r.type][r.status] = parseInt(r.c) || 0;
    }
    res.json({ byType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Prompt Presets ====================

app.get(`${BASE_PATH}/api/prompt-presets`, async (req, res) => {
  try {
    const { type, agent_id, limit } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT * FROM prompt_presets WHERE workspace_id = ?';
    const params = [req.workspace.id];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id); }
    sql += ' ORDER BY use_count DESC, created_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 100, 500));
    const result = await s.query(sql, params);
    const presets = (result.rows || []).map(p => ({ ...p, tags: p.tags ? JSON.parse(p.tags) : [] }));
    res.json({ presets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/prompt-presets`, async (req, res) => {
  try {
    const { name, description, prompt, type, agent_id, tags } = req.body;
    if (!name || !prompt || !type) return res.status(400).json({ error: 'name, prompt, and type are required' });
    const id = uuidv4();
    const s = scoped(req.workspace.id);
    await s.exec(
      'INSERT INTO prompt_presets (id, workspace_id, name, description, prompt, type, agent_id, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, name, description || '', prompt, type, agent_id || null, JSON.stringify(tags || []), req.user?.id || null]
    );
    res.json({ id, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch(`${BASE_PATH}/api/prompt-presets/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const updates = [];
    const params = [];
    for (const f of ['name', 'description', 'prompt', 'type', 'agent_id']) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.body.tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(req.body.tags)); }
    if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id, req.workspace.id);
    const r = await s.exec(`UPDATE prompt_presets SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`, params);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${BASE_PATH}/api/prompt-presets/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const r = await s.exec('DELETE FROM prompt_presets WHERE id = ? AND workspace_id = ?', [req.params.id, req.workspace.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Track preset usage (called by Studio when a preset is applied)
app.post(`${BASE_PATH}/api/prompt-presets/:id/use`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    await s.exec('UPDATE prompt_presets SET use_count = use_count + 1 WHERE id = ? AND workspace_id = ?', [req.params.id, req.workspace.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Brand Voices ====================

app.get(`${BASE_PATH}/api/brand-voices`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT * FROM brand_voices WHERE workspace_id = ? ORDER BY is_default DESC, created_at DESC',
      [req.workspace.id]
    );
    const voices = (result.rows || []).map(v => ({
      ...v,
      tone_words: v.tone_words ? JSON.parse(v.tone_words) : [],
      do_examples: v.do_examples ? JSON.parse(v.do_examples) : [],
      dont_examples: v.dont_examples ? JSON.parse(v.dont_examples) : [],
    }));
    res.json({ voices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/brand-voices`, async (req, res) => {
  try {
    const { name, description, tone_words, do_examples, dont_examples, style_guide, is_default } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uuidv4();
    const s = scoped(req.workspace.id);
    if (is_default) {
      await s.exec('UPDATE brand_voices SET is_default = 0 WHERE workspace_id = ?', [req.workspace.id]);
    }
    await s.exec(
      'INSERT INTO brand_voices (id, workspace_id, name, description, tone_words, do_examples, dont_examples, style_guide, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.workspace.id, name, description || '', JSON.stringify(tone_words || []), JSON.stringify(do_examples || []), JSON.stringify(dont_examples || []), style_guide || '', is_default ? 1 : 0]
    );

    // Best-effort embedding — failures don't block creation. The
    // content-text agent will skip this voice if embedding is null.
    bvSearch.embedBrandVoice({ name, description, tone_words, do_examples, dont_examples, style_guide })
      .then(async vec => {
        if (!vec) return;
        try {
          if (usePostgres) {
            await exec(
              'UPDATE brand_voices SET embedding = $1::vector, embedding_model = $2, embedding_dims = $3 WHERE id = $4',
              [`[${vec.join(',')}]`, 'text-embedding-3-small', vec.length, id]
            );
          } else {
            await exec(
              'UPDATE brand_voices SET embedding = ?, embedding_model = ?, embedding_dims = ? WHERE id = ?',
              [JSON.stringify(vec), 'text-embedding-3-small', vec.length, id]
            );
          }
        } catch (e) {
          log.warn('[brand-voice] persist embedding failed:', e.message);
        }
      })
      .catch(e => log.warn('[brand-voice] embedding pipeline failed:', e.message));

    res.json({ id, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${BASE_PATH}/api/brand-voices/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'DELETE FROM brand_voices WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Inbox messages (Community Agent) ---------------------------------

// List inbox rows for the current workspace. Supports filters:
//   status=open|resolved|snoozed, platform=twitter, priority=urgent|normal|low,
//   sentiment=negative|..., limit=50, offset=0.
app.get(`${BASE_PATH}/api/inbox-messages`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const clauses = ['workspace_id = ?'];
    const params = [req.workspace.id];
    for (const col of ['status', 'platform', 'priority', 'sentiment']) {
      if (req.query[col]) { clauses.push(`${col} = ?`); params.push(req.query[col]); }
    }
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    params.push(limit, offset);
    const result = await s.query(
      `SELECT id, platform, kind, external_id, thread_id, author_handle, author_name,
              author_avatar_url, text, url, sentiment, priority, status, assignee_user_id,
              draft_reply, replied_at, occurred_at, fetched_at, tags
       FROM inbox_messages
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(occurred_at, fetched_at) DESC
       LIMIT ? OFFSET ?`,
      params
    );
    const rows = (result.rows || []).map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));

    // Summary counters so the UI can render tab badges in one round-trip.
    const counts = await s.query(
      `SELECT status, COUNT(*) AS c FROM inbox_messages WHERE workspace_id = ? GROUP BY status`,
      [req.workspace.id]
    );
    const byStatus = {};
    for (const row of counts.rows || []) byStatus[row.status] = parseInt(row.c) || 0;
    res.json({ messages: rows, count: rows.length, by_status: byStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a single inbox row — typically flipping status (open → resolved),
// assigning to a user, or editing the draft_reply before send.
app.patch(`${BASE_PATH}/api/inbox-messages/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const allowed = ['status', 'priority', 'assignee_user_id', 'draft_reply', 'sentiment'];
    const sets = [];
    const params = [];
    for (const col of allowed) {
      if (req.body[col] !== undefined) { sets.push(`${col} = ?`); params.push(req.body[col]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    if (req.body.status === 'resolved' && req.body.mark_replied) {
      sets.push('replied_at = CURRENT_TIMESTAMP');
    }
    params.push(req.params.id, req.workspace.id);
    const result = await s.exec(
      `UPDATE inbox_messages SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'inbox_message not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync comments from Instagram / TikTok URLs into inbox_messages via Apify.
// Body: { platform: 'instagram' | 'tiktok', urls: ['...', ...], limit_per?: 50 }
// Idempotent — the (workspace_id, platform, external_id) unique index prevents
// dups on re-sync. Returns counts of inserted vs skipped.
app.post(`${BASE_PATH}/api/inbox-messages/sync-apify`, async (req, res) => {
  try {
    const commentHarvest = require('./comment-harvest');
    const { platform, urls, limit_per = 50 } = req.body || {};
    if (!platform || !['instagram', 'tiktok'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be instagram or tiktok' });
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'urls array required' });
    }
    if (urls.length > 20) return res.status(400).json({ error: 'Max 20 URLs per sync', code: 'TOO_MANY_URLS' });

    const harvest = platform === 'instagram'
      ? await commentHarvest.harvestInstagramComments({
          postUrls: urls,
          limitPerPost: Math.min(parseInt(limit_per, 10) || 50, 200),
          workspaceId: req.workspace.id,
        })
      : await commentHarvest.harvestTikTokComments({
          videoUrls: urls,
          limitPerVideo: Math.min(parseInt(limit_per, 10) || 50, 200),
          workspaceId: req.workspace.id,
        });

    if (!harvest.success) {
      return res.status(502).json({ error: harvest.error || 'Apify harvest failed', code: 'HARVEST_FAILED' });
    }

    let inserted = 0, skipped = 0;
    for (const c of harvest.comments) {
      try {
        const id = uuidv4();
        await exec(
          `INSERT INTO inbox_messages (id, workspace_id, platform, kind, external_id,
                  author_handle, author_name, text, url, occurred_at, fetched_at, raw)
           VALUES (?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
          [id, req.workspace.id, platform, c.external_id || null,
           c.author_handle || null, c.author_name || null, c.body || null,
           c.source_url || null, c.created_at || null, JSON.stringify(c).slice(0, 4000)]
        );
        inserted++;
      } catch (e) {
        // UNIQUE violation = already synced, skip silently
        if (/UNIQUE|duplicate/i.test(e.message)) skipped++;
        else throw e;
      }
    }

    res.json({ success: true, total: harvest.comments.length, inserted, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Standalone review harvest (no LLM analysis, returns reviews + rule-based
// sentiment summary). Cheaper than running review-miner if you just want the
// raw data. Body: { source: 'steam'|'app-store'|'play-store', app_id, country?, limit? }
app.post(`${BASE_PATH}/api/reviews/harvest`, async (req, res) => {
  try {
    const reviewHarvest = require('./review-harvest');
    const { source, app_id, country = 'us', limit = 200 } = req.body || {};
    if (!source || !app_id) return res.status(400).json({ error: 'source + app_id required' });
    const cappedLimit = Math.min(parseInt(limit, 10) || 200, 500);

    let r;
    const opts = { appId: app_id, country, limit: cappedLimit, workspaceId: req.workspace.id };
    if (source === 'steam') r = await reviewHarvest.harvestSteamReviews(opts);
    else if (source === 'app-store') r = await reviewHarvest.harvestAppStoreReviews(opts);
    else if (source === 'play-store') r = await reviewHarvest.harvestPlayStoreReviews(opts);
    else return res.status(400).json({ error: 'source must be steam, app-store, or play-store' });

    if (!r.success) return res.status(502).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ads/plan — synchronous wrapper around the ads agent.
// Returns { plan, cost, runId } once the agent finishes, or 400 on validation /
// 504 on timeout. The underlying run is still persisted to agent_runs /
// agent_traces for audit parity with the generic /api/agents/:id/run path.
app.post(`${BASE_PATH}/api/ads/plan`, async (req, res) => {
  const AGENT_ID = 'ads';
  const TIMEOUT_MS = 120_000;
  try {
    const agent = agentRuntime.getAgent(AGENT_ID);
    if (!agent) return res.status(404).json({ error: 'Ads agent not registered' });

    const estimate = agentRuntime.estimateCost(AGENT_ID, req.body) || {};
    const { runId, stream } = agentRuntime.createRun(AGENT_ID, req.body, {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      db: { query, queryOne, exec },
      uuidv4,
    });

    await exec(
      'INSERT INTO agent_runs (id, workspace_id, agent_id, user_id, input, status, cost_usd_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [runId, req.workspace?.id || null, AGENT_ID, req.user?.id || null, JSON.stringify(req.body || {}), 'running', estimate.usdCents || 0]
    );

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Ads plan timed out'), { status: 504 })), TIMEOUT_MS);
      stream.on('event', async (evt) => {
        try {
          await exec(
            'INSERT INTO agent_traces (id, run_id, event_type, data) VALUES (?, ?, ?, ?)',
            [uuidv4(), runId, evt.type, JSON.stringify(evt.data || {})]
          );
        } catch (persistErr) {
          console.warn('[ads.plan] trace persist error:', persistErr.message);
        }
        if (evt.type === 'complete') {
          clearTimeout(timer);
          const cost = evt.data?.cost || {};
          await exec(
            `UPDATE agent_runs SET status=?, output=?, cost_usd_cents=?, input_tokens=?, output_tokens=?, duration_ms=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
            ['complete', JSON.stringify(evt.data.output || {}), cost.usdCents || 0, cost.inputTokens || 0, cost.outputTokens || 0, evt.data.durationMs || null, runId]
          );
          resolve({ plan: evt.data.output, cost, runId });
        } else if (evt.type === 'error') {
          clearTimeout(timer);
          await exec(
            "UPDATE agent_runs SET status='error', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
            [evt.data?.message || 'unknown', runId]
          );
          reject(Object.assign(new Error(evt.data?.message || 'ads agent error'), { status: 400 }));
        }
      });
    });

    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/translate — synchronous wrapper around the translate agent.
// Mirrors /api/ads/plan: persists run + traces, resolves on 'complete',
// rejects on 'error' or timeout. Returns { translations, source_language,
// cost, runId }.
app.post(`${BASE_PATH}/api/translate`, async (req, res) => {
  const AGENT_ID = 'translate';
  const TIMEOUT_MS = 120_000;
  try {
    const agent = agentRuntime.getAgent(AGENT_ID);
    if (!agent) return res.status(404).json({ error: 'Translate agent not registered' });

    const estimate = agentRuntime.estimateCost(AGENT_ID, req.body) || {};
    const { runId, stream } = agentRuntime.createRun(AGENT_ID, req.body, {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      db: { query, queryOne, exec },
      uuidv4,
    });

    await exec(
      'INSERT INTO agent_runs (id, workspace_id, agent_id, user_id, input, status, cost_usd_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [runId, req.workspace?.id || null, AGENT_ID, req.user?.id || null, JSON.stringify(req.body || {}), 'running', estimate.usdCents || 0]
    );

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Translate timed out'), { status: 504 })), TIMEOUT_MS);
      stream.on('event', async (evt) => {
        try {
          await exec(
            'INSERT INTO agent_traces (id, run_id, event_type, data) VALUES (?, ?, ?, ?)',
            [uuidv4(), runId, evt.type, JSON.stringify(evt.data || {})]
          );
        } catch (persistErr) {
          console.warn('[translate] trace persist error:', persistErr.message);
        }
        if (evt.type === 'complete') {
          clearTimeout(timer);
          const cost = evt.data?.cost || {};
          await exec(
            `UPDATE agent_runs SET status=?, output=?, cost_usd_cents=?, input_tokens=?, output_tokens=?, duration_ms=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
            ['complete', JSON.stringify(evt.data.output || {}), cost.usdCents || 0, cost.inputTokens || 0, cost.outputTokens || 0, evt.data.durationMs || null, runId]
          );
          resolve({ ...(evt.data.output || {}), cost, runId });
        } else if (evt.type === 'error') {
          clearTimeout(timer);
          await exec(
            "UPDATE agent_runs SET status='error', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
            [evt.data?.message || 'unknown', runId]
          );
          reject(Object.assign(new Error(evt.data?.message || 'translate agent error'), { status: 400 }));
        }
      });
    });

    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Conductor — build a plan from a goal
app.post(`${BASE_PATH}/api/conductor/plan`, async (req, res) => {
  try {
    const { goal } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal is required' });
    if (!llm.isConfigured()) return res.status(400).json({ error: 'LLM provider not configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)' });

    const { plan, cost } = await conductor.buildPlan({
      goal, workspaceId: req.workspace.id, userId: req.user.id,
    });

    const planId = uuidv4();
    await exec(
      'INSERT INTO conductor_plans (id, workspace_id, goal, plan, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [planId, req.workspace.id, goal, JSON.stringify(plan), 'pending_approval', req.user.id]
    );
    const estimate = conductor.estimatePlanCost(plan);
    res.json({ planId, plan, cost, estimate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conductor — list plans in the current workspace
app.get(`${BASE_PATH}/api/conductor/plans`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT id, goal, status, created_at, approved_at, completed_at FROM conductor_plans WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.workspace.id]
    );
    res.json({ plans: result.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conductor — get a single plan with step status
app.get(`${BASE_PATH}/api/conductor/plans/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const plan = await s.queryOne(
      'SELECT * FROM conductor_plans WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    plan.plan = JSON.parse(plan.plan || '{}');
    res.json(plan);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conductor — approve + kick off execution
// Runs each step sequentially (DAG support can come later). Each step
// is dispatched as an agent run; the step stores the resulting runId.
app.post(`${BASE_PATH}/api/conductor/plans/:id/run`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const plan = await s.queryOne(
      'SELECT * FROM conductor_plans WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const planObj = JSON.parse(plan.plan || '{}');
    if (!Array.isArray(planObj.steps) || planObj.steps.length === 0) {
      return res.status(400).json({ error: 'Plan has no steps' });
    }

    await s.exec(
      "UPDATE conductor_plans SET status='running', approved_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [req.params.id, req.workspace.id]
    );

    // Kick off steps in sequence. Respond right away with the planId;
    // client polls /plans/:id for step progress.
    res.json({ success: true, planId: req.params.id, steps: planObj.steps.length });

    // Run in background. Strategy:
    //   - Build a dependency graph from step.dependsOn.
    //   - Process in "waves": all steps whose deps are already complete run
    //     concurrently via Promise.all. Steps that share a parallel_group are
    //     naturally captured in the same wave (they have no cross-deps).
    //   - If any step errors, later waves are skipped (marked 'skipped').
    (async () => {
      const steps = planObj.steps;
      const stepMap = Object.fromEntries(steps.map(s => [s.id, s]));
      const stepResults = [];
      const done = new Set();
      const errored = new Set();
      const resultById = {};

      const runStep = async (step) => {
        const agent = agentRuntime.getAgent(step.agent);
        if (!agent) {
          const r = { id: step.id, agent: step.agent, status: 'skipped', error: 'Agent not found', stage: step.stage };
          resultById[step.id] = r; return r;
        }
        const { runId, stream } = agentRuntime.createRun(step.agent, step.input, {
          workspaceId: req.workspace.id,
          userId: req.user.id,
          db: { query, queryOne, exec },
          uuidv4,
        });
        return await new Promise((resolve) => {
          let finalOutput = null;
          let finalError = null;
          let finalCost = null;
          stream.on('event', async (evt) => {
            try {
              await exec(
                'INSERT INTO agent_traces (id, run_id, event_type, data) VALUES (?, ?, ?, ?)',
                [uuidv4(), runId, evt.type, JSON.stringify(evt.data || {})]
              );
            } catch {}
            if (evt.type === 'complete') { finalOutput = evt.data.output; finalCost = evt.data.cost; }
            if (evt.type === 'error') finalError = evt.data?.message;
            if (evt.type === 'closed') {
              try {
                await exec(
                  `UPDATE agent_runs SET status=?, output=?, error=?, cost_usd_cents=?, input_tokens=?, output_tokens=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
                  [
                    finalError ? 'error' : 'complete',
                    finalOutput ? JSON.stringify(finalOutput) : null,
                    finalError || null,
                    finalCost?.usdCents || 0,
                    finalCost?.inputTokens || 0,
                    finalCost?.outputTokens || 0,
                    runId,
                  ]
                );
              } catch {}
              const r = {
                id: step.id, agent: step.agent, stage: step.stage, parallel_group: step.parallel_group,
                runId, status: finalError ? 'error' : 'complete',
                output: finalOutput, error: finalError,
              };
              resultById[step.id] = r;
              resolve(r);
            }
          });
          exec(
            'INSERT INTO agent_runs (id, workspace_id, agent_id, user_id, input, status) VALUES (?, ?, ?, ?, ?, ?)',
            [runId, req.workspace.id, step.agent, req.user.id, JSON.stringify(step.input || {}), 'running']
          ).catch(() => {});
        });
      };

      try {
        let guard = 0;
        while (done.size + errored.size < steps.length && guard++ < 50) {
          // Find ready steps: all deps done + not errored upstream.
          const ready = steps.filter(s => {
            if (done.has(s.id) || errored.has(s.id)) return false;
            const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
            if (deps.some(d => errored.has(d))) {
              errored.add(s.id);
              stepResults.push({ id: s.id, agent: s.agent, status: 'skipped', error: 'upstream failed', stage: s.stage });
              return false;
            }
            return deps.every(d => done.has(d));
          });
          if (ready.length === 0) {
            // Unresolvable deps — mark remaining as skipped and bail.
            for (const s of steps) {
              if (!done.has(s.id) && !errored.has(s.id)) {
                stepResults.push({ id: s.id, agent: s.agent, status: 'skipped', error: 'unreachable', stage: s.stage });
                errored.add(s.id);
              }
            }
            break;
          }
          // Run this wave in parallel.
          const waveResults = await Promise.all(ready.map(runStep));
          for (const r of waveResults) {
            stepResults.push(r);
            if (r.status === 'error') errored.add(r.id);
            else done.add(r.id);
          }
        }

        const allOk = stepResults.every(r => r.status === 'complete');
        // Persist final plan state with step results
        const updatedPlan = { ...planObj, stepResults };
        await exec(
          `UPDATE conductor_plans SET status=?, plan=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
          [allOk ? 'complete' : 'error', JSON.stringify(updatedPlan), req.params.id]
        );
      } catch (e) {
        console.error('[conductor run]', e);
        await exec(
          `UPDATE conductor_plans SET status='error' WHERE id=?`,
          [req.params.id]
        ).catch(() => {});
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Job queue stats
app.get(`${BASE_PATH}/api/queue/stats`, (req, res) => {
  res.json(jobQueue.getStats());
});

// Cache stats
app.get(`${BASE_PATH}/api/cache/stats`, (req, res) => {
  res.json(defaultCache.getStats());
});

// Database query stats (slow query log + averages)
app.get(`${BASE_PATH}/api/query/stats`, authMiddleware, rbac.requirePermission('system.manage'), (req, res) => {
  res.json(getQueryStats());
});

// Apify integration status
app.get(`${BASE_PATH}/api/apify/status`, (req, res) => {
  res.json({ configured: apify.isConfigured() });
});

// ==================== ROI Dashboard ====================

// Aggregated ROI metrics for a campaign
app.get(`${BASE_PATH}/api/campaigns/:id/roi`, async (req, res) => {
  try {
    // Verify campaign is in this workspace before running aggregation
    const parent = await queryOne(
      'SELECT id FROM campaigns WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Campaign not found' });
    const result = await getCampaignRoi(req.params.id, { query, queryOne });
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Email Templates ====================

// List available templates
app.get(`${BASE_PATH}/api/email-templates`, (req, res) => {
  res.json(emailTemplates.listTemplates());
});

// Render a template with variables (preview)
app.post(`${BASE_PATH}/api/email-templates/:id/render`, (req, res) => {
  try {
    const rendered = emailTemplates.renderEmail(req.params.id, req.body.variables || {});
    res.json(rendered);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ==================== Custom email templates (CRUD) ====================

// List templates: built-in + workspace's custom ones.
// Only parent templates are returned here (variant_of IS NULL). Variant
// children are fetched separately via /email-templates/:id/variants.
app.get(`${BASE_PATH}/api/email-templates/all`, async (req, res) => {
  try {
    const builtin = emailTemplates.listTemplates().map(t => ({ ...t, source: 'builtin' }));
    if (!req.workspace?.id) return res.json({ builtin, custom: [] });
    const s = scoped(req.workspace.id);
    const result = await s.query(
      `SELECT id, name, language, cooperation_type, subject, body, variables, is_default, updated_at,
              (SELECT COUNT(*) FROM email_templates v WHERE v.variant_of = email_templates.id AND v.workspace_id = email_templates.workspace_id) as variant_count
       FROM email_templates
       WHERE workspace_id = ? AND variant_of IS NULL
       ORDER BY updated_at DESC`,
      [req.workspace.id]
    );
    const custom = (result.rows || []).map(t => ({
      ...t,
      source: 'custom',
      variables: tryParseJson(t.variables),
      variant_count: parseInt(t.variant_count) || 0,
    }));
    res.json({ builtin, custom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${BASE_PATH}/api/email-templates`, async (req, res) => {
  try {
    const { name, language, cooperation_type, subject, body, variables } = req.body || {};
    if (!name || !subject || !body) return res.status(400).json({ error: 'name, subject, body required' });
    const id = uuidv4();
    const s = scoped(req.workspace.id);
    await s.exec(
      `INSERT INTO email_templates (id, workspace_id, name, language, cooperation_type, subject, body, variables, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, req.workspace.id, name, language || 'en', cooperation_type || null, subject, body,
        JSON.stringify(Array.isArray(variables) ? variables : []), req.user?.id || null]
    );
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put(`${BASE_PATH}/api/email-templates/:id`, async (req, res) => {
  try {
    const { name, language, cooperation_type, subject, body, variables } = req.body || {};
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      `UPDATE email_templates SET
         name = COALESCE(?, name),
         language = COALESCE(?, language),
         cooperation_type = COALESCE(?, cooperation_type),
         subject = COALESCE(?, subject),
         body = COALESCE(?, body),
         variables = COALESCE(?, variables),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND workspace_id = ?`,
      [name || null, language || null, cooperation_type || null, subject || null, body || null,
        variables ? JSON.stringify(variables) : null, req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete(`${BASE_PATH}/api/email-templates/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    // Deleting a parent cascades to its variants (kept tidy — variants alone
    // are meaningless without the parent's metadata).
    await s.exec(
      'DELETE FROM email_templates WHERE variant_of = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    const result = await s.exec(
      'DELETE FROM email_templates WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List variants for a given template (the parent + all variants).
app.get(`${BASE_PATH}/api/email-templates/:id/variants`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT * FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    const variants = await s.query(
      'SELECT * FROM email_templates WHERE variant_of = ? AND workspace_id = ? ORDER BY created_at ASC',
      [req.params.id, req.workspace.id]
    );
    res.json({ parent, variants: variants.rows || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a new variant of an existing template. Body mirrors the parent
// CRUD but inherits language / cooperation_type from the parent if absent.
app.post(`${BASE_PATH}/api/email-templates/:id/variants`, async (req, res) => {
  try {
    const { variant_label, subject, body, variables } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject, body required' });
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT * FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    const id = uuidv4();
    await s.exec(
      `INSERT INTO email_templates
         (id, workspace_id, name, language, cooperation_type, subject, body, variables,
          variant_of, variant_label, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, req.workspace.id,
        `${parent.name} — ${variant_label || 'variant'}`,
        parent.language, parent.cooperation_type,
        subject, body,
        JSON.stringify(Array.isArray(variables) ? variables : []),
        parent.id, variant_label || 'variant',
        req.user?.id || null]
    );
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pick a variant (including the parent itself) for this contact to send.
// If the parent has a winner_variant_id set, we deterministically send that
// one (auto-winner mode). Otherwise we do uniform random pick across
// parent + variants. In both cases we record template_id/variant_id on the
// contact so the thread + stats can attribute outcomes back.
app.post(`${BASE_PATH}/api/contacts/:id/pick-variant`, async (req, res) => {
  try {
    const { template_id } = req.body || {};
    if (!template_id) return res.status(400).json({ error: 'template_id required' });
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT * FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [template_id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    const vrs = await s.query(
      'SELECT * FROM email_templates WHERE variant_of = ? AND workspace_id = ?',
      [template_id, req.workspace.id]
    );

    let chosen;
    if (parent.winner_variant_id) {
      // Auto-winner mode: always pick the promoted winner. If the winner is
      // the parent itself, winner_variant_id may be set to parent.id.
      chosen = parent.winner_variant_id === parent.id
        ? parent
        : (vrs.rows || []).find(v => v.id === parent.winner_variant_id) || parent;
    } else {
      const pool = [parent, ...(vrs.rows || [])];
      chosen = pool[Math.floor(Math.random() * pool.length)];
    }

    await s.exec(
      'UPDATE contacts SET template_id=?, variant_id=? WHERE id=? AND workspace_id=?',
      [parent.id, chosen.id === parent.id ? null : chosen.id, req.params.id, req.workspace.id]
    );
    res.json({
      template_id: parent.id,
      variant_id: chosen.id === parent.id ? null : chosen.id,
      autoWinner: !!parent.winner_variant_id,
      chosen: {
        id: chosen.id,
        name: chosen.name,
        variant_label: chosen.variant_label || null,
        subject: chosen.subject,
        body: chosen.body,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Promote a variant (or the parent itself) as the winner. Subsequent
// pick-variant calls will route 100% of traffic to this variant.
// Toggle the auto-promote flag on a parent template. When ON, the stats
// endpoint will set winner_variant_id automatically once the suggested
// winner is statistically significant. Admin controls this per-template.
app.patch(`${BASE_PATH}/api/email-templates/:id/auto-promote`, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT id FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    await s.exec(
      'UPDATE email_templates SET auto_promote_winner = ? WHERE id = ? AND workspace_id = ?',
      [enabled ? 1 : 0, req.params.id, req.workspace.id]
    );
    res.json({ success: true, auto_promote_winner: enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${BASE_PATH}/api/email-templates/:id/promote-winner`, async (req, res) => {
  try {
    const { winner_id } = req.body || {};
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT id FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    if (winner_id === null || winner_id === undefined) {
      await s.exec(
        'UPDATE email_templates SET winner_variant_id = NULL WHERE id = ? AND workspace_id = ?',
        [req.params.id, req.workspace.id]
      );
      return res.json({ success: true, winner_variant_id: null });
    }
    // winner_id must be parent itself or one of its variants
    const valid = winner_id === parent.id || !!(await s.queryOne(
      'SELECT id FROM email_templates WHERE id = ? AND variant_of = ? AND workspace_id = ?',
      [winner_id, parent.id, req.workspace.id]
    ));
    if (!valid) return res.status(400).json({ error: 'winner_id must be the parent or one of its variants' });
    await s.exec(
      'UPDATE email_templates SET winner_variant_id = ? WHERE id = ? AND workspace_id = ?',
      [winner_id, req.params.id, req.workspace.id]
    );
    res.json({ success: true, winner_variant_id: winner_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A/B stats for a parent template: sent / opened / replied per variant
// (parent counts as the "control" / null variant_id).
app.get(`${BASE_PATH}/api/email-templates/:id/stats`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT id, name, winner_variant_id, auto_promote_winner FROM email_templates WHERE id = ? AND workspace_id = ? AND variant_of IS NULL',
      [req.params.id, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Parent template not found' });
    const variants = await s.query(
      'SELECT id, name, variant_label FROM email_templates WHERE variant_of = ? AND workspace_id = ? ORDER BY created_at ASC',
      [req.params.id, req.workspace.id]
    );

    // Aggregate per (template_id, variant_id) tuple. Parent row contributes
    // variant_id = NULL; variant rows use their own id. We count by terminal
    // contact.status for a coarse funnel — this ignores multi-open events
    // but is cheap and good enough for relative A/B.
    const rows = await s.query(
      `SELECT variant_id,
         COUNT(*) as sent,
         SUM(CASE WHEN status IN ('delivered','opened','replied') THEN 1 ELSE 0 END) as delivered,
         SUM(CASE WHEN status IN ('opened','replied') THEN 1 ELSE 0 END) as opened,
         SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) as replied,
         SUM(CASE WHEN status IN ('bounced','failed') THEN 1 ELSE 0 END) as failed
       FROM contacts
       WHERE workspace_id = ? AND template_id = ? AND status != 'draft'
       GROUP BY variant_id`,
      [req.workspace.id, parent.id]
    );

    const byVariant = {};
    for (const r of rows.rows || []) {
      byVariant[r.variant_id || '_parent'] = {
        sent: parseInt(r.sent) || 0,
        delivered: parseInt(r.delivered) || 0,
        opened: parseInt(r.opened) || 0,
        replied: parseInt(r.replied) || 0,
        failed: parseInt(r.failed) || 0,
      };
    }

    const zero = { sent: 0, delivered: 0, opened: 0, replied: 0, failed: 0 };
    const payload = [
      { id: parent.id, name: parent.name, variant_label: 'parent', isParent: true, ...(byVariant._parent || zero) },
      ...(variants.rows || []).map(v => ({
        id: v.id,
        name: v.name,
        variant_label: v.variant_label || 'variant',
        isParent: false,
        ...(byVariant[v.id] || zero),
      })),
    ].map(row => ({
      ...row,
      open_rate: row.sent > 0 ? ((row.opened / row.sent) * 100).toFixed(1) : '0.0',
      reply_rate: row.sent > 0 ? ((row.replied / row.sent) * 100).toFixed(1) : '0.0',
    }));

    // Suggested winner via two-proportion z-test on reply_rate vs the best
    // alternative. Only suggest when min sample >= 30 per arm and p < 0.05,
    // which are common thresholds for lightweight A/B calls. No correction
    // for multiple comparisons — at N=2-3 variants that's fine; the user
    // still makes the final promote call.
    const MIN_SAMPLE = 30;
    const P_THRESHOLD = 0.05;
    const best = payload.reduce((m, r) => (r.replied / Math.max(r.sent, 1) > m.replied / Math.max(m.sent, 1) ? r : m), payload[0]);
    let suggestedWinner = null;
    if (best && best.sent >= MIN_SAMPLE) {
      // Compare the best to the aggregate of the rest.
      const others = payload.filter(r => r.id !== best.id);
      const othersSent = others.reduce((s, r) => s + r.sent, 0);
      const othersReplied = others.reduce((s, r) => s + r.replied, 0);
      if (othersSent >= MIN_SAMPLE) {
        const p = abSig.twoPropZPValue(best.replied, best.sent, othersReplied, othersSent);
        if (p != null && p < P_THRESHOLD) {
          suggestedWinner = { id: best.id, variant_label: best.variant_label, p_value: p.toFixed(4) };
        }
      }
    }

    // Auto-promotion: when the parent template has auto_promote_winner=1
    // and we have a significant suggestion AND no winner is yet set, persist
    // the winner now. Admin can still manually clear/change it later. This
    // runs on stats reads (cheap, observable) rather than a background job
    // — the stats endpoint is what surfaces A/B state to the UI anyway.
    let autoPromoted = false;
    if (parent.auto_promote_winner && !parent.winner_variant_id && suggestedWinner) {
      try {
        await s.exec(
          'UPDATE email_templates SET winner_variant_id = ? WHERE id = ? AND workspace_id = ?',
          [suggestedWinner.id, parent.id, req.workspace.id]
        );
        parent.winner_variant_id = suggestedWinner.id;
        autoPromoted = true;
        log.info('[ab] auto-promoted winner', { template: parent.id, variant: suggestedWinner.id, p: suggestedWinner.p_value });
      } catch (e) {
        log.warn('[ab] auto-promote failed:', e.message);
      }
    }

    res.json({
      parent,
      variants: payload,
      winner_variant_id: parent.winner_variant_id || null,
      auto_promote_winner: !!parent.auto_promote_winner,
      auto_promoted_now: autoPromoted,
      suggested_winner: suggestedWinner,
      min_sample_for_significance: MIN_SAMPLE,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Significance helpers moved to ./ab-significance for testability.

function tryParseJson(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

// ==================== Mailbox accounts (outbound identities) ====================
// Workspace-scoped. credentials_encrypted stores provider-specific secrets as
// JSON. Once we add a workspace-scoped keyring we'll wrap this in a sealed box.
function sanitizeMailbox(row) {
  if (!row) return row;
  const { credentials_encrypted, ...safe } = row;
  let creds = {};
  if (credentials_encrypted) {
    try { creds = secrets.decrypt(credentials_encrypted) || {}; }
    catch { creds = {}; }
  }
  return {
    ...safe,
    // Only expose non-secret hints to the client.
    credentials: {
      has_api_key: !!creds.api_key,
      smtp_host: creds.smtp_host || null,
      smtp_port: creds.smtp_port || null,
      smtp_user: creds.smtp_user || null,
      has_smtp_pass: !!creds.smtp_pass,
      has_refresh_token: !!creds.refresh_token,
      gmail_user_email: creds.gmail_user_email || null,
    },
  };
}
function readCredsRaw(stored) {
  if (!stored) return {};
  try { return secrets.decrypt(stored) || {}; } catch { return {}; }
}

app.get(`${BASE_PATH}/api/mailboxes`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(
      'SELECT * FROM mailbox_accounts WHERE workspace_id = ? ORDER BY is_default DESC, created_at DESC',
      [req.workspace.id]
    );
    res.json({
      items: (result.rows || []).map(sanitizeMailbox),
      envFallback: {
        hasResend: !!process.env.RESEND_API_KEY,
        hasSmtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
        fromEmail: process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${BASE_PATH}/api/mailboxes`, async (req, res) => {
  try {
    const { provider, from_email, from_name, reply_to, signature_html, credentials, is_default } = req.body || {};
    if (!provider || !from_email) return res.status(400).json({ error: 'provider and from_email required' });
    if (!['resend', 'smtp'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider (expected resend|smtp)' });

    // Credentials schema: { api_key } for resend, { smtp_host, smtp_port, smtp_user, smtp_pass } for smtp.
    const creds = credentials || {};
    if (provider === 'resend' && !creds.api_key) return res.status(400).json({ error: 'api_key required for resend' });
    if (provider === 'smtp' && (!creds.smtp_host || !creds.smtp_user || !creds.smtp_pass)) {
      return res.status(400).json({ error: 'smtp_host, smtp_user, smtp_pass required for smtp' });
    }

    const id = uuidv4();
    const s = scoped(req.workspace.id);

    // If is_default=true, clear the default flag on other rows first.
    if (is_default) {
      await s.exec(
        'UPDATE mailbox_accounts SET is_default = 0 WHERE workspace_id = ?',
        [req.workspace.id]
      );
    }
    await s.exec(
      `INSERT INTO mailbox_accounts
         (id, workspace_id, provider, from_email, from_name, reply_to, signature_html,
          credentials_encrypted, status, is_default, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)`,
      [id, req.workspace.id, provider, from_email, from_name || null, reply_to || null,
        signature_html || null, secrets.encrypt(creds), is_default ? 1 : 0, req.user?.id || null]
    );
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch(`${BASE_PATH}/api/mailboxes/:id`, async (req, res) => {
  try {
    const { from_email, from_name, reply_to, signature_html, credentials, is_default, status } = req.body || {};
    const s = scoped(req.workspace.id);

    if (is_default) {
      await s.exec(
        'UPDATE mailbox_accounts SET is_default = 0 WHERE workspace_id = ? AND id != ?',
        [req.workspace.id, req.params.id]
      );
    }

    // Merge credentials: if supplied, overlay onto existing stored creds so
    // callers can change just one field (e.g. rotate the api_key) without
    // resending the others.
    let credsBlob = null;
    if (credentials && typeof credentials === 'object') {
      const existing = await s.queryOne(
        'SELECT credentials_encrypted FROM mailbox_accounts WHERE id=? AND workspace_id=?',
        [req.params.id, req.workspace.id]
      );
      const prev = existing ? readCredsRaw(existing.credentials_encrypted) : {};
      credsBlob = secrets.encrypt({ ...prev, ...credentials });
    }

    const result = await s.exec(
      `UPDATE mailbox_accounts SET
         from_email = COALESCE(?, from_email),
         from_name = COALESCE(?, from_name),
         reply_to = COALESCE(?, reply_to),
         signature_html = COALESCE(?, signature_html),
         credentials_encrypted = COALESCE(?, credentials_encrypted),
         is_default = COALESCE(?, is_default),
         status = COALESCE(?, status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id=? AND workspace_id=?`,
      [from_email || null, from_name || null, reply_to || null, signature_html || null,
        credsBlob, typeof is_default === 'boolean' ? (is_default ? 1 : 0) : null,
        status || null, req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Mailbox not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete(`${BASE_PATH}/api/mailboxes/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'DELETE FROM mailbox_accounts WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Mailbox not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify a mailbox connection (test-mode ping; doesn't send anything).
app.post(`${BASE_PATH}/api/mailboxes/:id/verify`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const mb = await s.queryOne(
      'SELECT * FROM mailbox_accounts WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!mb) return res.status(404).json({ error: 'Mailbox not found' });
    const result = await mailAgent.verifyConnection(mb);
    // If the Gmail flow refreshed the token, persist it.
    if (result.refreshedCreds) {
      try {
        await s.exec(
          'UPDATE mailbox_accounts SET credentials_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?',
          [secrets.encrypt(result.refreshedCreds), req.params.id, req.workspace.id]
        );
      } catch (e) {
        console.warn('[mailbox verify] failed to persist refreshed creds:', e.message);
      }
    }
    await s.exec(
      `UPDATE mailbox_accounts SET last_verified_at = CURRENT_TIMESTAMP, last_error = ?,
         status = ? WHERE id = ? AND workspace_id = ?`,
      [result.error || null, result.verified ? 'active' : 'error', req.params.id, req.workspace.id]
    );
    // Don't leak the refreshed creds back to the client.
    const { refreshedCreds, ...safe } = result;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Workspace-wide outreach tasks (for Pipeline "Email Tasks" tab).
// Returns the recent pending / failed / bounced contacts, annotated with
// KOL display info, so the UI can surface retry-worthy work across all
// campaigns.
app.get(`${BASE_PATH}/api/outreach/tasks`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const pending = await s.query(
      `SELECT c.id, c.status, c.send_error, c.bounce_reason, c.sent_at, c.delivered_at,
              c.last_opened_at, c.reply_at, c.send_attempts, c.email_subject,
              c.last_send_attempt_at, c.campaign_id,
              k.display_name, k.username, k.email as kol_email, k.platform, k.avatar_url,
              cam.name as campaign_name
       FROM contacts c
       JOIN kols k ON c.kol_id = k.id
       LEFT JOIN campaigns cam ON c.campaign_id = cam.id
       WHERE c.workspace_id = ?
         AND c.status IN ('pending', 'failed', 'bounced')
       ORDER BY c.last_send_attempt_at DESC, c.created_at DESC
       LIMIT 100`,
      [req.workspace.id]
    );
    const scheduled = await s.query(
      `SELECT c.id, c.status, c.email_subject, c.scheduled_send_at, c.campaign_id,
              k.display_name, k.username, k.email as kol_email, k.platform, k.avatar_url,
              cam.name as campaign_name
       FROM contacts c
       JOIN kols k ON c.kol_id = k.id
       LEFT JOIN campaigns cam ON c.campaign_id = cam.id
       WHERE c.workspace_id = ?
         AND c.scheduled_send_at IS NOT NULL
         AND c.sent_at IS NULL
       ORDER BY c.scheduled_send_at ASC
       LIMIT 100`,
      [req.workspace.id]
    );
    const recent = await s.query(
      `SELECT c.id, c.status, c.sent_at, c.delivered_at, c.first_opened_at, c.last_opened_at,
              c.reply_at, c.email_subject, c.campaign_id,
              k.display_name, k.username, k.email as kol_email, k.platform, k.avatar_url,
              cam.name as campaign_name
       FROM contacts c
       JOIN kols k ON c.kol_id = k.id
       LEFT JOIN campaigns cam ON c.campaign_id = cam.id
       WHERE c.workspace_id = ?
         AND c.status IN ('sent', 'delivered', 'opened')
       ORDER BY COALESCE(c.last_opened_at, c.delivered_at, c.sent_at) DESC
       LIMIT 30`,
      [req.workspace.id]
    );
    res.json({
      pending: pending.rows || [],
      recent: recent.rows || [],
      scheduled: scheduled.rows || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Gmail mailbox OAuth ====================

// Check whether Gmail OAuth is configured on this deployment (client-side
// hides the button when not).
app.get(`${BASE_PATH}/api/mailboxes/oauth/gmail/status`, (req, res) => {
  res.json({ configured: gmailOAuth.isConfigured() });
});

// Start Gmail OAuth. We stash the workspace_id in `state` so the callback
// (which Google calls without our auth header) knows where to attach the
// resulting mailbox_accounts row.
app.post(`${BASE_PATH}/api/mailboxes/oauth/gmail/init`, (req, res) => {
  try {
    if (!gmailOAuth.isConfigured()) {
      return res.status(501).json({ error: 'Gmail OAuth not configured. Set GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET.' });
    }
    const { url } = gmailOAuth.buildAuthorizeUrl({
      workspaceId: req.workspace.id,
      userId: req.user?.id,
      returnTo: req.body?.returnTo || '/',
    });
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google redirects here with ?code + ?state. No auth header — state is the
// trust anchor. On success we create/update a mailbox_accounts row and
// close the popup so the parent ConnectionsPage can reload.
app.get(`${BASE_PATH}/api/mailboxes/oauth/gmail/callback`, async (req, res) => {
  try {
    const { code, state, error: gErr } = req.query;
    if (gErr) return res.status(400).send(`<script>window.close();</script>Gmail OAuth error: ${gErr}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    const entry = gmailOAuth.consumeState(state);
    if (!entry) return res.status(400).send('Invalid or expired state');

    const tokens = await gmailOAuth.exchangeCodeForTokens(code);
    const profile = await gmailOAuth.fetchProfile(tokens.access_token);

    const creds = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 3500) * 1000,
      scope: tokens.scope,
      gmail_user_email: profile.email,
    };

    // One Gmail identity per workspace — upsert on from_email.
    const existing = await queryOne(
      'SELECT id FROM mailbox_accounts WHERE workspace_id = ? AND provider = ? AND from_email = ?',
      [entry.workspaceId, 'gmail_oauth', profile.email]
    );
    const credsBlob = secrets.encrypt(creds);
    if (existing) {
      await exec(
        `UPDATE mailbox_accounts SET credentials_encrypted = ?, status = 'active',
           last_error = NULL, last_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [credsBlob, existing.id]
      );
    } else {
      await exec(
        `INSERT INTO mailbox_accounts
           (id, workspace_id, provider, from_email, from_name, credentials_encrypted,
            status, is_default, last_verified_at, created_by, updated_at)
         VALUES (?, ?, 'gmail_oauth', ?, ?, ?, 'active', 0, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
        [uuidv4(), entry.workspaceId, profile.email, profile.name || null,
          credsBlob, entry.userId || null]
      );
    }

    res.type('html').send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail connected</title>
      <style>body{font-family:system-ui;background:#0f1114;color:#eee;text-align:center;padding:60px 20px}</style></head>
      <body>
        <h2>✅ Gmail connected as ${profile.email}</h2>
        <p>You can close this window and return to InfluenceX.</p>
        <script>try { window.opener && window.opener.postMessage({ type:'gmail-oauth-complete' }, '*'); } catch(e){} setTimeout(()=>window.close(), 800);</script>
      </body></html>
    `);
  } catch (e) {
    console.error('[gmail-oauth callback]', e);
    res.status(500).type('html').send(`<script>window.close();</script>Gmail OAuth error: ${String(e.message).slice(0, 200)}`);
  }
});

// Email queue stats: specifically for email.* job types
app.get(`${BASE_PATH}/api/email-queue/stats`, (req, res) => {
  const s = jobQueue.getStats();
  res.json({
    ...s,
    emailTypes: s.registeredTypes.filter(t => t.startsWith('email.')),
  });
});

// Manually enqueue the safety-net sync job that fails contacts stuck in
// 'pending' > 30min. Useful for admins debugging a stuck batch.
app.post(`${BASE_PATH}/api/email-queue/sync-status`, (req, res) => {
  try {
    const id = jobQueue.push('email.sync_status', {}, { maxRetries: 0 });
    res.json({ queued: true, jobId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sender-domain DNS checks (SPF / DKIM / DMARC). Helps users diagnose why
// outbound mail lands in spam. We do live DNS lookups — cheap but not
// cached. For larger deployments, a 5-minute memoize would be appropriate.
app.get(`${BASE_PATH}/api/mailboxes/:id/dns-check`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const mb = await s.queryOne(
      'SELECT id, from_email, provider FROM mailbox_accounts WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!mb) return res.status(404).json({ error: 'Mailbox not found' });
    const domain = (mb.from_email || '').split('@')[1];
    if (!domain) return res.status(400).json({ error: 'Cannot derive domain from from_email' });

    const dns = require('dns').promises;
    async function resolveTxt(name) {
      try { return (await dns.resolveTxt(name)).map(r => r.join('')); }
      catch (e) { return []; }
    }

    const [spfRaw, dmarcRaw] = await Promise.all([
      resolveTxt(domain),
      resolveTxt(`_dmarc.${domain}`),
    ]);

    const spf = spfRaw.find(r => r.toLowerCase().startsWith('v=spf1')) || null;
    const dmarc = dmarcRaw.find(r => r.toLowerCase().startsWith('v=dmarc1')) || null;

    // DKIM selector varies by provider. For gmail_oauth typically `google`
    // (for Workspace-signed mail). For Resend it's the domain-specific
    // selector in their dashboard. We only check the common ones here.
    const dkimSelectors = mb.provider === 'gmail_oauth' ? ['google', 'google2', 'google3'] : ['resend', 'default'];
    const dkim = {};
    for (const sel of dkimSelectors) {
      const rec = await resolveTxt(`${sel}._domainkey.${domain}`);
      if (rec.length > 0) { dkim[sel] = rec[0]; break; }
    }

    res.json({
      domain,
      provider: mb.provider,
      spf: { present: !!spf, record: spf },
      dkim: { selectors_checked: dkimSelectors, found: dkim },
      dmarc: { present: !!dmarc, record: dmarc },
      advice: buildDnsAdvice({ spf, dmarc, dkim, provider: mb.provider, domain }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildDnsAdvice({ spf, dmarc, dkim, provider, domain }) {
  const advice = [];
  if (!spf) advice.push(`Add an SPF TXT record to ${domain}. For Gmail Workspace: "v=spf1 include:_spf.google.com ~all"; for Resend: "v=spf1 include:amazonses.com ~all".`);
  else if (!/include:/i.test(spf)) advice.push(`SPF exists but no include:. Verify it covers your provider's sending infrastructure.`);
  if (Object.keys(dkim).length === 0) {
    advice.push(provider === 'gmail_oauth'
      ? `No DKIM record found. In Google Workspace, generate a DKIM key (Admin Console → Apps → Gmail → Authenticate email) and publish its TXT record as google._domainkey.${domain}.`
      : `No DKIM record found. Your email provider will give you a DKIM selector + TXT value to publish under <selector>._domainkey.${domain}.`);
  }
  if (!dmarc) advice.push(`No DMARC. Start with a monitoring-only policy: "v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}" at _dmarc.${domain}. Tighten to p=quarantine once aligned.`);
  if (advice.length === 0) advice.push('Looks good — SPF, DKIM, and DMARC all present.');
  return advice;
}

// Render a template for a specific KOL contact
app.post(`${BASE_PATH}/api/contacts/:id/render-template`, async (req, res) => {
  try {
    const templateId = req.body.template_id;
    if (!templateId) return res.status(400).json({ error: 'template_id required' });

    const s = scoped(req.workspace.id);
    const contact = await s.queryOne(
      `SELECT c.*, k.display_name, k.username, k.platform, k.followers, k.category, k.email as kol_email
       FROM contacts c JOIN kols k ON c.kol_id = k.id WHERE c.id = ? AND c.workspace_id = ?`,
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const campaign = await s.queryOne(
      'SELECT name FROM campaigns WHERE id = ? AND workspace_id = ?',
      [contact.campaign_id, req.workspace.id]
    );

    const variables = {
      kol_name: contact.display_name || contact.username,
      kol_handle: contact.username,
      platform: contact.platform,
      followers: emailTemplates.formatFollowers(contact.followers),
      category: contact.category || 'content creation',
      campaign_name: campaign?.name || '',
      sender_name: req.body.sender_name || process.env.SENDER_NAME || 'The Team',
      product_name: req.body.product_name || process.env.PRODUCT_NAME || campaign?.name || '',
      cooperation_type: contact.cooperation_type,
      price_quote: contact.price_quote || '',
      ...req.body.extra_variables,
    };

    const rendered = emailTemplates.renderEmail(templateId, variables);
    res.json({ ...rendered, variables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all KOLs in the workspace's global database
app.get(`${BASE_PATH}/api/kol-database`, async (req, res) => {
  try {
    const { platform, search, status, sort } = req.query;
    const s = scoped(req.workspace.id);
    let sql = 'SELECT * FROM kol_database WHERE workspace_id = ?';
    const params = [req.workspace.id];
    if (platform) { sql += ' AND platform = ?'; params.push(platform); }
    if (status) { sql += ' AND scrape_status = ?'; params.push(status); }
    if (search) { sql += ' AND (username LIKE ? OR display_name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (sort === 'followers') sql += ' ORDER BY followers DESC';
    else if (sort === 'score') sql += ' ORDER BY ai_score DESC';
    else if (sort === 'engagement') sql += ' ORDER BY engagement_rate DESC';
    else sql += ' ORDER BY created_at DESC';
    const result = await s.query(sql, params);
    const kols = result.rows;
    kols.forEach(k => k.tags = JSON.parse(k.tags || '[]'));
    res.json(kols);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single KOL from database
app.get(`${BASE_PATH}/api/kol-database/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const kol = await s.queryOne(
      'SELECT * FROM kol_database WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!kol) return res.status(404).json({ error: 'KOL not found' });
    kol.tags = JSON.parse(kol.tags || '[]');
    res.json(kol);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add KOL by profile URL - triggers AI scrape
app.post(`${BASE_PATH}/api/kol-database`, async (req, res) => {
  try {
    const { profile_url, platform } = req.body;
    if (!profile_url) return res.status(400).json({ error: 'Profile URL is required' });

    // Detect platform from URL
    let detectedPlatform = platform || 'unknown';
    if (profile_url.includes('tiktok.com')) detectedPlatform = 'tiktok';
    else if (profile_url.includes('youtube.com') || profile_url.includes('youtu.be')) detectedPlatform = 'youtube';
    else if (profile_url.includes('instagram.com')) detectedPlatform = 'instagram';
    else if (profile_url.includes('twitch.tv')) detectedPlatform = 'twitch';
    else if (profile_url.includes('twitter.com') || profile_url.includes('x.com')) detectedPlatform = 'x';

    const username = extractUsernameFromUrl(profile_url, detectedPlatform);
    const s = scoped(req.workspace.id);

    // Check for duplicate within this workspace
    const existing = await s.queryOne(
      'SELECT id FROM kol_database WHERE workspace_id = ? AND (profile_url = ? OR (platform = ? AND username = ?))',
      [req.workspace.id, profile_url, detectedPlatform, username]
    );
    if (existing) return res.status(409).json({ error: 'This KOL already exists in the database', id: existing.id });

    const id = uuidv4();
    await s.exec(
      "INSERT INTO kol_database (id, workspace_id, platform, username, display_name, profile_url, scrape_status) VALUES (?, ?, ?, ?, ?, ?, 'scraping')",
      [id, req.workspace.id, detectedPlatform, username, username, profile_url]
    );

    // Simulate AI scrape asynchronously
    setTimeout(() => scrapeAndEnrichKol(id, profile_url, detectedPlatform, username), 100);

    res.json({ id, platform: detectedPlatform, username, profile_url, scrape_status: 'scraping' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch add KOLs by URLs
app.post(`${BASE_PATH}/api/kol-database/batch`, async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls array is required' });

    const s = scoped(req.workspace.id);
    const results = [];
    for (const url of urls) {
      const trimmed = url.trim();
      if (!trimmed) continue;

      let platform = 'unknown';
      if (trimmed.includes('tiktok.com')) platform = 'tiktok';
      else if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) platform = 'youtube';
      else if (trimmed.includes('instagram.com')) platform = 'instagram';
      else if (trimmed.includes('twitch.tv')) platform = 'twitch';
      else if (trimmed.includes('twitter.com') || trimmed.includes('x.com')) platform = 'x';

      const username = extractUsernameFromUrl(trimmed, platform);
      const existing = await s.queryOne(
        'SELECT id FROM kol_database WHERE workspace_id = ? AND (profile_url = ? OR (platform = ? AND username = ?))',
        [req.workspace.id, trimmed, platform, username]
      );
      if (existing) { results.push({ url: trimmed, status: 'duplicate', id: existing.id }); continue; }

      const id = uuidv4();
      await s.exec(
        "INSERT INTO kol_database (id, workspace_id, platform, username, display_name, profile_url, scrape_status) VALUES (?, ?, ?, ?, ?, ?, 'scraping')",
        [id, req.workspace.id, platform, username, username, trimmed]
      );
      setTimeout(() => scrapeAndEnrichKol(id, trimmed, platform, username), 100 + results.length * 500);
      results.push({ url: trimmed, status: 'queued', id, platform, username });
    }
    res.json({ queued: results.filter(r => r.status === 'queued').length, duplicates: results.filter(r => r.status === 'duplicate').length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete KOL from database
app.delete(`${BASE_PATH}/api/kol-database/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      'DELETE FROM kol_database WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'KOL not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import KOLs from a campaign into the global database
app.post(`${BASE_PATH}/api/kol-database/import-campaign/:campaignId`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const parent = await s.queryOne(
      'SELECT id FROM campaigns WHERE id=? AND workspace_id=?',
      [req.params.campaignId, req.workspace.id]
    );
    if (!parent) return res.status(404).json({ error: 'Campaign not found' });

    const campaignKolsResult = await s.query(
      'SELECT * FROM kols WHERE campaign_id = ? AND workspace_id = ?',
      [req.params.campaignId, req.workspace.id]
    );
    const campaignKols = campaignKolsResult.rows;
    let imported = 0, skipped = 0;

    for (const k of campaignKols) {
      const existing = await s.queryOne(
        'SELECT id FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
        [req.workspace.id, k.platform, k.username]
      );
      if (existing) { skipped++; continue; }

      const id = uuidv4();
      await s.exec(
        "INSERT INTO kol_database (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, category, email, bio, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?)",
        [id, req.workspace.id, k.platform, k.username, k.display_name, k.avatar_url, k.profile_url || `https://${k.platform}.com/@${k.username}`, k.followers, k.engagement_rate, k.avg_views, k.category, k.email, k.bio, k.ai_score, k.ai_reason, k.estimated_cpm, req.params.campaignId]
      );
      imported++;
    }
    res.json({ imported, skipped, total: campaignKols.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Dashboard Stats ====================
app.get(`${BASE_PATH}/api/stats`, async (req, res) => {
  try {
    const campaigns = (await queryOne('SELECT COUNT(*) as count FROM campaigns')).count;
    const totalKols = (await queryOne('SELECT COUNT(*) as count FROM kols')).count;
    const approvedKols = (await queryOne("SELECT COUNT(*) as count FROM kols WHERE status = 'approved'")).count;
    const sentEmails = (await queryOne("SELECT COUNT(*) as count FROM contacts WHERE status = 'sent' OR status = 'replied'")).count;
    const replies = (await queryOne("SELECT COUNT(*) as count FROM contacts WHERE status = 'replied'")).count;
    const totalViews = (await queryOne('SELECT COALESCE(SUM(views), 0) as total FROM content_data')).total;
    res.json({
      campaigns: parseInt(campaigns) || 0,
      totalKols: parseInt(totalKols) || 0,
      approvedKols: parseInt(approvedKols) || 0,
      sentEmails: parseInt(sentEmails) || 0,
      replies: parseInt(replies) || 0,
      totalViews: parseInt(totalViews) || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Pipeline API (Task 1: Scrape -> Write -> Mail) ====================

// Start pipeline for a URL
app.post(`${BASE_PATH}/api/pipeline/start`, async (req, res) => {
  try {
    const { profile_url, campaign_id } = req.body;
    if (!profile_url) return res.status(400).json({ error: 'profile_url is required' });

    // Detect platform
    let platform = 'unknown';
    if (profile_url.includes('youtube.com') || profile_url.includes('youtu.be')) platform = 'youtube';
    else if (profile_url.includes('tiktok.com')) platform = 'tiktok';
    else if (profile_url.includes('instagram.com')) platform = 'instagram';
    else if (profile_url.includes('twitch.tv')) platform = 'twitch';

    const username = extractUsernameFromUrl(profile_url, platform);
    const id = uuidv4();
    const workspaceId = req.workspace.id;

    // Require an explicit campaign_id that belongs to this workspace.
    // For legacy clients that omit it, fall back to the first campaign in the workspace.
    let campaignId = campaign_id;
    if (campaignId) {
      const ok = await queryOne(
        'SELECT id FROM campaigns WHERE id=? AND workspace_id=?',
        [campaignId, workspaceId]
      );
      if (!ok) return res.status(404).json({ error: 'Campaign not found in this workspace' });
    } else {
      const fallback = await queryOne(
        'SELECT id FROM campaigns WHERE workspace_id=? ORDER BY created_at ASC LIMIT 1',
        [workspaceId]
      );
      if (!fallback) return res.status(400).json({ error: 'No campaigns in this workspace — create one first' });
      campaignId = fallback.id;
    }

    // Create pipeline job
    await exec(
      "INSERT INTO pipeline_jobs (id, workspace_id, profile_url, platform, username, campaign_id, stage, source) VALUES (?, ?, ?, ?, ?, ?, 'scrape', 'manual')",
      [id, workspaceId, profile_url, platform, username, campaignId]
    );

    // Run pipeline async
    runPipeline(id, profile_url, platform, username, campaignId, workspaceId).catch(async (e) => {
      console.error('Pipeline error:', e);
      await exec("UPDATE pipeline_jobs SET stage='error', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [e.message, id]);
    });

    res.json({ id, stage: 'scrape', profile_url, platform, username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runPipeline(jobId, profileUrl, platform, username, campaignId, workspaceId) {
  // === Stage 1: SCRAPE ===
  console.log(`[Pipeline ${jobId}] Stage 1: Scraping ${username} on ${platform}...`);

  const scrapeResult = await scraper.scrapeProfile(profileUrl, platform, username, { workspaceId });

  if (!scrapeResult.success) {
    await exec("UPDATE pipeline_jobs SET stage='error', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [scrapeResult.error, jobId]);
    return;
  }

  const d = scrapeResult.data;

  // Save to kol_database
  const kolId = uuidv4();
  const score = calculateAIScore(
    { platform, followers: d.followers, engagement_rate: d.engagement_rate, avg_views: d.avg_views, category: d.category },
    { min_followers: 10000, min_engagement: 2, categories: 'Gaming, Tech, AI' },
    'Gaming and AI roleplay KOL campaign for HakkoAI'
  );

  if (usePostgres) {
    await exec(
      `INSERT INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, following, engagement_rate, avg_views, total_videos, category, email, bio, country, language, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url, profile_url=EXCLUDED.profile_url, followers=EXCLUDED.followers, following=EXCLUDED.following, engagement_rate=EXCLUDED.engagement_rate, avg_views=EXCLUDED.avg_views, total_videos=EXCLUDED.total_videos, category=EXCLUDED.category, email=EXCLUDED.email, bio=EXCLUDED.bio, country=EXCLUDED.country, language=EXCLUDED.language, ai_score=EXCLUDED.ai_score, ai_reason=EXCLUDED.ai_reason, estimated_cpm=EXCLUDED.estimated_cpm, scrape_status='complete', source_campaign_id=EXCLUDED.source_campaign_id, updated_at=CURRENT_TIMESTAMP`,
      [kolId, platform, username, d.display_name || username, d.avatar_url || '', profileUrl, d.followers || 0, d.following || 0, d.engagement_rate || 0, d.avg_views || 0, d.total_videos || 0, d.category || '', d.email || '', d.bio || '', d.country || '', d.language || '', score.score, score.reason, score.estimatedCpm, campaignId]
    );
  } else {
    await exec(
      `INSERT OR REPLACE INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, following, engagement_rate, avg_views, total_videos, category, email, bio, country, language, ai_score, ai_reason, estimated_cpm, scrape_status, source_campaign_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, CURRENT_TIMESTAMP)`,
      [kolId, platform, username, d.display_name || username, d.avatar_url || '', profileUrl, d.followers || 0, d.following || 0, d.engagement_rate || 0, d.avg_views || 0, d.total_videos || 0, d.category || '', d.email || '', d.bio || '', d.country || '', d.language || '', score.score, score.reason, score.estimatedCpm, campaignId]
    );
  }

  // Store scrape result in pipeline
  await exec("UPDATE pipeline_jobs SET kol_database_id=?, scrape_result=?, email_to=?, stage='write', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [kolId, JSON.stringify(d), d.email || '', jobId]);

  // === Stage 2: WRITE ===
  console.log(`[Pipeline ${jobId}] Stage 2: Generating outreach email...`);

  const campaign = await queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  const campaignObj = campaign || { name: 'HakkoAI', description: 'AI gaming assistant' };
  if (campaign?.platforms) campaignObj.platforms = JSON.parse(campaign.platforms || '[]');

  const emailContent = await generateOutreachEmail(
    { display_name: d.display_name || username, platform, followers: d.followers, username, category: d.category, engagement_rate: d.engagement_rate, avg_views: d.avg_views, bio: d.bio },
    campaignObj,
    'affiliate', ''
  );

  // Also save email to kol_database
  await exec("UPDATE kol_database SET outreach_email_subject=?, outreach_email_body=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [emailContent.subject, emailContent.body, kolId]);

  // Create contact record with draft status
  const contactId = uuidv4();

  // First ensure a KOL record exists in the kols table for this campaign+workspace
  const existingKol = await queryOne(
    'SELECT id FROM kols WHERE campaign_id=? AND username=? AND platform=? AND workspace_id=?',
    [campaignId, username, platform, workspaceId]
  );
  let campaignKolId = existingKol?.id;
  if (!campaignKolId) {
    campaignKolId = uuidv4();
    await exec(
      "INSERT INTO kols (id, workspace_id, campaign_id, platform, username, display_name, avatar_url, followers, engagement_rate, avg_views, category, email, profile_url, bio, ai_score, ai_reason, estimated_cpm, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')",
      [campaignKolId, workspaceId, campaignId, platform, username, d.display_name || username, d.avatar_url || '', d.followers || 0, d.engagement_rate || 0, d.avg_views || 0, d.category || '', d.email || '', profileUrl, d.bio || '', score.score, score.reason, score.estimatedCpm]
    );
  }

  await exec(
    "INSERT INTO contacts (id, workspace_id, kol_id, campaign_id, email_subject, email_body, cooperation_type, status) VALUES (?, ?, ?, ?, ?, ?, 'affiliate', 'draft')",
    [contactId, workspaceId, campaignKolId, campaignId, emailContent.subject, emailContent.body]
  );

  await exec("UPDATE pipeline_jobs SET contact_id=?, email_subject=?, email_body=?, stage='review', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [contactId, emailContent.subject, emailContent.body, jobId]);

  console.log(`[Pipeline ${jobId}] Stage 2 complete. Email draft created, waiting for review.`);
}

// List pipeline jobs
app.get(`${BASE_PATH}/api/pipeline/jobs`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const result = await s.query(`
      SELECT pj.*, kd.display_name, kd.avatar_url, kd.followers, kd.engagement_rate, kd.avg_views, kd.category
      FROM pipeline_jobs pj
      LEFT JOIN kol_database kd ON pj.kol_database_id = kd.id
      WHERE pj.workspace_id = ?
      ORDER BY pj.created_at DESC
    `, [req.workspace.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single pipeline job
app.get(`${BASE_PATH}/api/pipeline/jobs/:id`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const job = await s.queryOne(`
      SELECT pj.*, kd.display_name, kd.avatar_url, kd.followers, kd.engagement_rate, kd.avg_views, kd.category, kd.bio, kd.email as kol_email
      FROM pipeline_jobs pj
      LEFT JOIN kol_database kd ON pj.kol_database_id = kd.id
      WHERE pj.id = ? AND pj.workspace_id = ?
    `, [req.params.id, req.workspace.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.scrape_result) job.scrape_result = JSON.parse(job.scrape_result);
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Edit pipeline email
app.post(`${BASE_PATH}/api/pipeline/jobs/:id/edit`, async (req, res) => {
  try {
    const { email_subject, email_body, email_to } = req.body;
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      "UPDATE pipeline_jobs SET email_subject=?, email_body=?, email_to=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [email_subject, email_body, email_to || null, req.params.id, req.workspace.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Job not found' });

    // Also update the contact record (same workspace)
    const job = await s.queryOne(
      'SELECT contact_id FROM pipeline_jobs WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (job?.contact_id) {
      await s.exec(
        "UPDATE contacts SET email_subject=?, email_body=? WHERE id=? AND workspace_id=?",
        [email_subject, email_body, job.contact_id, req.workspace.id]
      );
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve and send email
// Approve the review-stage draft and queue it for send. Routes through the
// same email.send job queue as /api/contacts/:id/send — the worker updates
// the contact row (status, sent_at, email_replies) and the pipeline UI
// JOINs contacts to reflect live state. This removes the old parallel
// approve → sync sendEmail path that used a deprecated signature and
// couldn't leverage workspace-specific mailbox_accounts.
app.post(`${BASE_PATH}/api/pipeline/jobs/:id/approve`, sendEmailLimiter, sendEmailWorkspaceLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const job = await s.queryOne(
      'SELECT * FROM pipeline_jobs WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.stage !== 'review') return res.status(400).json({ error: `Job is in stage "${job.stage}", not "review"` });

    const emailTo = req.body.email_to || job.email_to;
    if (!emailTo) return res.status(400).json({ error: 'No email address available for this KOL. Set email_to.' });

    if (!job.contact_id) {
      return res.status(500).json({
        error: 'Pipeline job has no linked contact — was it created before the pipeline→contact linker was added? Reject and retry.',
        code: 'NO_CONTACT',
      });
    }

    // Mark pipeline + contact as pending; enqueue the send. Worker handles
    // the actual Resend call, status updates, and email_replies insert.
    await s.exec(
      "UPDATE pipeline_jobs SET email_approved=1, email_to=?, stage='send', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [emailTo, job.id, req.workspace.id]
    );
    await s.exec(
      "UPDATE contacts SET status='pending', send_error=NULL, kol_email=COALESCE(kol_email, ?), email_subject=?, email_body=? WHERE id=? AND workspace_id=?",
      [emailTo, job.email_subject, job.email_body, job.contact_id, req.workspace.id]
    );

    const jobId = jobQueue.push('email.send', {
      contactId: job.contact_id,
      toOverride: emailTo,
    }, { maxRetries: 3 });

    res.json({ success: true, queued: true, jobQueueId: jobId, contactId: job.contact_id, pipelineJobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reject / regenerate email
app.post(`${BASE_PATH}/api/pipeline/jobs/:id/reject`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const job = await s.queryOne(
      'SELECT * FROM pipeline_jobs WHERE id=? AND workspace_id=?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Regenerate email
    const scrapeData = job.scrape_result ? JSON.parse(job.scrape_result) : {};
    const campaign = (await s.queryOne(
      'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?',
      [job.campaign_id, req.workspace.id]
    )) || { name: 'HakkoAI', description: 'AI gaming assistant' };

    const emailContent = await generateOutreachEmail(
      { display_name: scrapeData.display_name || job.username, platform: job.platform, followers: scrapeData.followers || 0, username: job.username, category: scrapeData.category, engagement_rate: scrapeData.engagement_rate, avg_views: scrapeData.avg_views, bio: scrapeData.bio },
      campaign,
      'affiliate', ''
    );

    await s.exec(
      "UPDATE pipeline_jobs SET email_subject=?, email_body=?, error=NULL, stage='review', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [emailContent.subject, emailContent.body, job.id, req.workspace.id]
    );

    if (job.contact_id) {
      await s.exec(
        "UPDATE contacts SET email_subject=?, email_body=? WHERE id=? AND workspace_id=?",
        [emailContent.subject, emailContent.body, job.contact_id, req.workspace.id]
      );
    }

    res.json({ success: true, email_subject: emailContent.subject, email_body: emailContent.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SMTP status
app.get(`${BASE_PATH}/api/smtp/status`, async (req, res) => {
  const status = await mailAgent.verifyConnection();
  res.json(status);
});

// ==================== Content Scraping API (Task 2) ====================

// Scrape view counts for content URLs
app.post(`${BASE_PATH}/api/data/content/scrape`, async (req, res) => {
  try {
    // Scrape ALL content (not just views=0), to get daily snapshots
    const contentResult = await query("SELECT id, content_url, platform FROM content_data WHERE content_url IS NOT NULL AND content_url != ''");
    const content = contentResult.rows;

    if (content.length === 0) return res.json({ scraped: 0, message: 'No content URLs to scrape' });

    const today = new Date().toISOString().split('T')[0];
    const results = { scraped: 0, errors: 0 };

    for (const item of content) {
      const data = await dataAgent.scrapeContentUrl(item.content_url);
      if (data && (data.views > 0 || data.likes > 0)) {
        // Update current totals in content_data
        await exec("UPDATE content_data SET views=?, likes=?, comments=?, shares=?, publish_date=COALESCE(NULLIF(?, ''), publish_date) WHERE id=?",
          [data.views, data.likes, data.comments, data.shares, data.publish_date, item.id]);

        // Save daily snapshot
        if (usePostgres) {
          await exec("INSERT INTO content_daily_stats (id, content_url, stat_date, views, likes, comments, shares, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'scrape') ON CONFLICT (content_url, stat_date) DO UPDATE SET views=EXCLUDED.views, likes=EXCLUDED.likes, comments=EXCLUDED.comments, shares=EXCLUDED.shares",
            [uuidv4(), item.content_url, today, data.views, data.likes, data.comments, data.shares]);
        } else {
          await exec("INSERT OR REPLACE INTO content_daily_stats (id, content_url, stat_date, views, likes, comments, shares, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'scrape')",
            [uuidv4(), item.content_url, today, data.views, data.likes, data.comments, data.shares]);
        }

        results.scraped++;
      } else {
        results.errors++;
      }
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual update content stats
app.put(`${BASE_PATH}/api/data/content/:id`, async (req, res) => {
  try {
    const { views, likes, comments, shares } = req.body;
    const { id } = req.params;

    const item = await queryOne("SELECT * FROM content_data WHERE id=?", [id]);
    if (!item) return res.status(404).json({ error: 'Content not found' });

    await exec("UPDATE content_data SET views=?, likes=?, comments=?, shares=? WHERE id=?",
      [parseInt(views) || 0, parseInt(likes) || 0, parseInt(comments) || 0, parseInt(shares) || 0, id]);

    // Save daily snapshot with manual source
    const today = new Date().toISOString().split('T')[0];
    if (usePostgres) {
      await exec("INSERT INTO content_daily_stats (id, content_url, stat_date, views, likes, comments, shares, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual') ON CONFLICT (content_url, stat_date) DO UPDATE SET views=EXCLUDED.views, likes=EXCLUDED.likes, comments=EXCLUDED.comments, shares=EXCLUDED.shares, source='manual'",
        [uuidv4(), item.content_url, today, parseInt(views) || 0, parseInt(likes) || 0, parseInt(comments) || 0, parseInt(shares) || 0]);
    } else {
      await exec("INSERT OR REPLACE INTO content_daily_stats (id, content_url, stat_date, views, likes, comments, shares, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')",
        [uuidv4(), item.content_url, today, parseInt(views) || 0, parseInt(likes) || 0, parseInt(comments) || 0, parseInt(shares) || 0]);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get daily stats for a content URL
app.get(`${BASE_PATH}/api/data/content/:id/daily`, async (req, res) => {
  try {
    const item = await queryOne("SELECT content_url FROM content_data WHERE id=?", [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Content not found' });

    const stats = await query("SELECT stat_date, views, likes, comments, shares, source FROM content_daily_stats WHERE content_url=? ORDER BY stat_date", [item.content_url]);
    res.json({ content_url: item.content_url, daily: stats.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Combined dashboard data
app.get(`${BASE_PATH}/api/data/dashboard/combined`, async (req, res) => {
  try {
    // 1. Content data by date
    const contentByDateResult = await query(`
      SELECT publish_date as date, SUM(views) as views, SUM(likes) as likes, SUM(comments) as comments, COUNT(*) as content_count
      FROM content_data WHERE publish_date IS NOT NULL AND publish_date != ''
      GROUP BY publish_date ORDER BY publish_date
    `);
    const contentByDate = contentByDateResult.rows;

    // 2. Registration data by date
    const regByDateResult = await query(`
      SELECT date, SUM(registrations) as registrations FROM registration_data
      GROUP BY date ORDER BY date
    `);
    const regByDate = regByDateResult.rows;

    const gaData = [];

    // 4. Key events (content publish dates)
    const eventsResult = await query("SELECT * FROM dashboard_events ORDER BY date");
    const events = eventsResult.rows;

    // Also add content publish dates as events
    // Note: GROUP_CONCAT is SQLite-specific, use STRING_AGG for PostgreSQL
    let contentDates;
    if (usePostgres) {
      const cdResult = await query(`
        SELECT publish_date as date, COUNT(*) as count, STRING_AGG(kol_name, ',') as kols
        FROM content_data WHERE publish_date IS NOT NULL AND publish_date != ''
        GROUP BY publish_date
      `);
      contentDates = cdResult.rows;
    } else {
      const cdResult = await query(`
        SELECT publish_date as date, COUNT(*) as count, GROUP_CONCAT(kol_name) as kols
        FROM content_data WHERE publish_date IS NOT NULL AND publish_date != ''
        GROUP BY publish_date
      `);
      contentDates = cdResult.rows;
    }

    // Merge all data by date
    const allDates = new Set();
    contentByDate.forEach(d => allDates.add(d.date));
    regByDate.forEach(d => allDates.add(d.date));
    gaData.forEach(d => allDates.add(d.date));

    const combined = [...allDates].sort().map(date => {
      const content = contentByDate.find(d => d.date === date) || {};
      const reg = regByDate.find(d => d.date === date) || {};
      const ga = gaData.find(d => d.date === date) || {};
      const pubEvent = contentDates.find(d => d.date === date);

      return {
        date,
        views: parseInt(content.views) || 0,
        likes: parseInt(content.likes) || 0,
        content_count: parseInt(content.content_count) || 0,
        registrations: parseInt(reg.registrations) || 0,
        uv: ga.uv || 0,
        sessions: ga.sessions || 0,
        has_publish: !!pubEvent,
        publish_info: pubEvent ? `${pubEvent.count} content by ${pubEvent.kols}` : null,
      };
    });

    res.json({
      combined,
      events: [...events, ...contentDates.map(d => ({ date: d.date, event_type: 'content_publish', label: `${d.count} content published`, metadata: JSON.stringify({ kols: d.kols }) }))],
      totals: {
        total_views: contentByDate.reduce((s, d) => s + (parseInt(d.views) || 0), 0),
        total_registrations: regByDate.reduce((s, d) => s + (parseInt(d.registrations) || 0), 0),
        total_content: contentByDate.reduce((s, d) => s + (parseInt(d.content_count) || 0), 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Discovery API (Task 3) ====================

// Start discovery
// Resolve a default campaign_id for the caller's workspace. Used when
// discovery-start is called without an explicit campaign_id (e.g. from the
// "Discovery" tab on PipelinePage, which doesn't know which campaign it's
// bound to). Prefers an active campaign, falls back to any campaign, and
// throws if the workspace has none — refusing to leak into the global
// hakko-q1-all seed like the old code did.
async function defaultCampaignForWorkspace(workspaceId) {
  const active = await queryOne(
    "SELECT id FROM campaigns WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1",
    [workspaceId]
  );
  if (active) return active.id;
  const any = await queryOne(
    'SELECT id FROM campaigns WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
    [workspaceId]
  );
  return any?.id || null;
}

app.post(`${BASE_PATH}/api/discovery/start`, discoveryLimiter, async (req, res) => {
  try {
    const { campaign_id, keywords, platforms, min_subscribers, max_results } = req.body;
    const searchKeywords = keywords || 'gaming AI roleplay, AI character game, AI NPC gaming, AI companion roleplay';

    // Explicit campaign_id must belong to caller's workspace; otherwise fall
    // back to workspace's default campaign. No more global seed leakage.
    let resolvedCampaignId = null;
    if (campaign_id) {
      const owned = await queryOne(
        'SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?',
        [campaign_id, req.workspace.id]
      );
      if (!owned) return res.status(404).json({ error: 'Campaign not found in this workspace' });
      resolvedCampaignId = owned.id;
    } else {
      resolvedCampaignId = await defaultCampaignForWorkspace(req.workspace.id);
      if (!resolvedCampaignId) {
        return res.status(400).json({
          error: 'No campaign exists in this workspace. Create one before running discovery.',
          code: 'NO_CAMPAIGN',
        });
      }
    }

    const jobId = uuidv4();
    await exec(
      'INSERT INTO discovery_jobs (id, workspace_id, campaign_id, search_criteria, status) VALUES (?, ?, ?, ?, ?)',
      [
        jobId,
        req.workspace.id,
        resolvedCampaignId,
        JSON.stringify({ keywords: searchKeywords, platforms: platforms || ['youtube'], min_subscribers: min_subscribers || 1000, max_results: max_results || 50 }),
        'running',
      ]
    );

    // Run discovery async. Any failure writes to error_message so the UI
    // can surface a reason instead of a bare "error" badge.
    //
    // Per-platform dispatch: YouTube uses Data API v3, Instagram/TikTok use
    // Apify hashtag scrapers. Each platform's results are merged into the
    // same discovery_results rows (the `platform` column distinguishes them);
    // the downstream pipeline scrape stage already dispatches by platform.
    const requestedPlatforms = (Array.isArray(platforms) && platforms.length)
      ? platforms
      : ['youtube'];
    (async () => {
      try {
        const allChannels = [];
        const errors = [];

        for (const platform of requestedPlatforms) {
          let r;
          try {
            if (platform === 'youtube') {
              r = await discoveryAgent.searchYouTubeChannels({
                keywords: searchKeywords,
                maxResults: max_results || 50,
                minSubscribers: min_subscribers || 1000,
              });
            } else if (platform === 'instagram') {
              r = await igDiscovery.searchInstagramHashtag({
                keywords: searchKeywords,
                maxResults: max_results || 50,
                minSubscribers: min_subscribers || 1000,
                workspaceId: req.workspace?.id,
              });
            } else if (platform === 'tiktok') {
              r = await tiktokDiscovery.searchTikTokHashtag({
                keywords: searchKeywords,
                maxResults: max_results || 50,
                minSubscribers: min_subscribers || 1000,
                workspaceId: req.workspace?.id,
              });
            } else if (platform === 'x') {
              r = await xDiscovery.searchXKeyword({
                keywords: searchKeywords,
                maxResults: max_results || 50,
                minSubscribers: min_subscribers || 1000,
                workspaceId: req.workspace?.id,
              });
            } else if (platform === 'reddit') {
              r = await redditDiscovery.searchRedditKeyword({
                keywords: searchKeywords,
                maxResults: max_results || 50,
                minSubscribers: min_subscribers || 100,
                workspaceId: req.workspace?.id,
              });
            } else {
              errors.push(`${platform}: unsupported`);
              continue;
            }
          } catch (e) {
            errors.push(`${platform}: ${e.message}`);
            continue;
          }
          if (r && r.success) {
            allChannels.push(...(r.channels || []));
          } else if (r && r.error) {
            errors.push(`${platform}: ${r.error}`);
          }
        }

        if (allChannels.length === 0) {
          await exec(
            "UPDATE discovery_jobs SET status='error', error_message=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
            [(errors.join('; ') || 'no candidates found').slice(0, 500), jobId]
          );
          console.warn('[discovery] no results:', errors.join('; '));
          return;
        }

        await transaction(async (tx) => {
          for (const ch of allChannels) {
            await tx.exec(
              'INSERT INTO discovery_results (id, job_id, platform, channel_url, channel_name, subscribers, relevance_score, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [uuidv4(), jobId, ch.platform, ch.channel_url, ch.channel_name, ch.subscribers, ch.relevance_score, 'found']
            );
          }
        });

        // If we found *some* candidates but a subset of platforms errored,
        // surface the partial errors alongside a 'complete' status so admins
        // can see which platforms didn't pull their weight.
        await exec(
          "UPDATE discovery_jobs SET status='complete', total_found=?, error_message=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
          [allChannels.length, errors.length ? errors.join('; ').slice(0, 500) : null, jobId]
        );
      } catch (e) {
        await exec(
          "UPDATE discovery_jobs SET status='error', error_message=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
          [String(e.message || e).slice(0, 500), jobId]
        );
        console.error('[discovery] exception:', e.message);
      }
    })();

    res.json({ id: jobId, status: 'running', keywords: searchKeywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List discovery jobs — scoped to caller's workspace.
app.get(`${BASE_PATH}/api/discovery/jobs`, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM discovery_jobs WHERE workspace_id = ? ORDER BY created_at DESC',
      [req.workspace.id]
    );
    const jobs = result.rows;
    jobs.forEach(j => { j.search_criteria = JSON.parse(j.search_criteria || '{}'); });
    res.json(jobs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a discovery job + its results — scoped to caller's workspace.
// Save selected discovery results into the workspace's KOL Database
// WITHOUT triggering an outreach pipeline. Useful when the user wants to
// shelf candidates for later — alternative to /process which queues emails.
//
// Body: { result_ids: [...] }   (or empty / omitted = save all "found")
// Returns counts of inserted vs skipped (already-existing handle).
app.post(`${BASE_PATH}/api/discovery/jobs/:id/save-to-db`, async (req, res) => {
  try {
    const job = await queryOne(
      'SELECT id FROM discovery_jobs WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { result_ids } = req.body || {};
    let rows;
    if (Array.isArray(result_ids) && result_ids.length > 0) {
      const placeholders = result_ids.map(() => '?').join(',');
      const r = await query(
        `SELECT * FROM discovery_results WHERE job_id=? AND id IN (${placeholders})`,
        [job.id, ...result_ids]
      );
      rows = r.rows;
    } else {
      const r = await query(
        "SELECT * FROM discovery_results WHERE job_id=? AND status='found'",
        [job.id]
      );
      rows = r.rows;
    }

    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const username = r.channel_url.split('/').pop().replace(/^@/, '');
      const existing = await queryOne(
        'SELECT id FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?',
        [req.workspace.id, r.platform, username]
      );
      if (existing) { skipped++; continue; }
      try {
        await exec(
          `INSERT INTO kol_database (id, workspace_id, platform, username, display_name, profile_url,
              followers, ai_score, scrape_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [uuidv4(), req.workspace.id, r.platform, username, r.channel_name || username,
           r.channel_url, r.subscribers || 0, r.relevance_score || null]
        );
        inserted++;
      } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) skipped++;
        else throw e;
      }
    }

    res.json({ success: true, total: rows.length, inserted, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export the candidate list of a discovery job to CSV. Uses the
// `discoveryResults` column preset so the file's columns match the on-screen
// table users see in DiscoveryPage.
app.get(`${BASE_PATH}/api/discovery/jobs/:id/export`, exportLimiter, async (req, res) => {
  try {
    const job = await queryOne(
      'SELECT id, status FROM discovery_jobs WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const r = await query(
      'SELECT * FROM discovery_results WHERE job_id=? ORDER BY relevance_score DESC, subscribers DESC',
      [job.id]
    );
    sendCsv(res, r.rows || [], csvExport.COLUMNS.discoveryResults, `discovery-${req.params.id.slice(0, 8)}.csv`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get(`${BASE_PATH}/api/discovery/jobs/:id`, async (req, res) => {
  try {
    const job = await queryOne(
      'SELECT * FROM discovery_jobs WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.search_criteria = JSON.parse(job.search_criteria || '{}');

    const resultsResult = await query(
      'SELECT * FROM discovery_results WHERE job_id=? ORDER BY relevance_score DESC, subscribers DESC',
      [job.id]
    );
    res.json({ ...job, results: resultsResult.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Process discovery results through the pipeline. Scoped to caller's
// workspace; creates pipeline_jobs tagged with the same workspace_id.
app.post(`${BASE_PATH}/api/discovery/jobs/:id/process`, async (req, res) => {
  try {
    const job = await queryOne(
      'SELECT * FROM discovery_jobs WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { min_relevance = 30, max_process = 10, result_ids } = req.body;

    // Two modes:
    //   1. Top-N by score (legacy): { min_relevance, max_process }
    //   2. Explicit selection from UI: { result_ids: [...] }
    // When result_ids is present, it wins — the user has hand-picked these.
    let results;
    if (Array.isArray(result_ids) && result_ids.length > 0) {
      // Build a placeholder list. SQLite + Postgres both accept "?, ?, ?".
      const placeholders = result_ids.map(() => '?').join(',');
      const r = await query(
        `SELECT * FROM discovery_results WHERE job_id=? AND status='found' AND id IN (${placeholders})`,
        [job.id, ...result_ids]
      );
      results = r.rows;
    } else {
      const r = await query(
        "SELECT * FROM discovery_results WHERE job_id=? AND status='found' AND relevance_score >= ? ORDER BY relevance_score DESC LIMIT ?",
        [job.id, min_relevance, max_process]
      );
      results = r.rows;
    }

    // If the job has no campaign (shouldn't happen post-fix, but defensive),
    // fall back to the workspace's default campaign.
    const campaignId = job.campaign_id || (await defaultCampaignForWorkspace(req.workspace.id));
    if (!campaignId) {
      return res.status(400).json({ error: 'No campaign to associate with these jobs', code: 'NO_CAMPAIGN' });
    }

    const processed = [];
    for (const r of results) {
      const pipelineId = uuidv4();
      const username = r.channel_url.split('/').pop();

      await exec(
        "INSERT INTO pipeline_jobs (id, workspace_id, profile_url, platform, username, campaign_id, stage, source) VALUES (?, ?, ?, ?, ?, ?, 'scrape', 'discovery')",
        [pipelineId, req.workspace.id, r.channel_url, r.platform, username, campaignId]
      );

      await exec(
        "UPDATE discovery_results SET pipeline_job_id=?, status='queued' WHERE id=?",
        [pipelineId, r.id]
      );

      // Run pipeline async with a small spacer between kicks so the
      // per-host scrape APIs don't see a burst. workspaceId is required
      // so the write stage creates a contact row inside the right tenant.
      runPipeline(pipelineId, r.channel_url, r.platform, username, campaignId, req.workspace.id).catch(e => {
        console.error(`Pipeline error for ${r.channel_name}:`, e.message);
      });

      processed.push({ channel: r.channel_name, pipelineId });
      await new Promise(r => setTimeout(r, 1000));
    }

    await exec(
      'UPDATE discovery_jobs SET total_processed=total_processed+? WHERE id=?',
      [processed.length, job.id]
    );

    res.json({ processed: processed.length, jobs: processed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Batch KOL Discovery (email-only) ====================
// Searches YouTube & TikTok, scrapes profiles, only saves those with emails
app.post(`${BASE_PATH}/api/discovery/batch-email`, async (req, res) => {
  try {
    const jobId = uuidv4();
    const platforms = req.body.platforms || ['youtube', 'tiktok'];
    const keywords = req.body.keywords || [
      'gaming AI roleplay', 'AI character game', 'AI NPC gaming', 'AI companion',
      'AI roleplay app', 'character AI review', 'AI game review', 'AI chatbot game',
      'gaming content creator', 'indie game review', 'mobile game review',
      'game recommendation', 'roleplay game', 'AI tools gaming',
    ];
    const minSubscribers = req.body.min_subscribers || 5000;

    await exec("INSERT INTO discovery_jobs (id, campaign_id, search_criteria, status) VALUES (?, 'batch-email', ?, 'running')",
      [jobId, JSON.stringify({ keywords, platforms, minSubscribers, mode: 'email-only' })]);

    res.json({ id: jobId, status: 'running', message: 'Batch discovery started. Only KOLs with emails will be saved.' });

    // Run in background
    (async () => {
      let totalFound = 0, totalWithEmail = 0, totalSaved = 0;
      const seenIds = new Set();

      console.log(`[BatchDiscovery ${jobId}] Starting. Keywords: ${keywords.length}, Platforms: ${platforms.join(',')}`);

      // ---- YouTube Discovery ----
      if (platforms.includes('youtube') && YOUTUBE_API_KEY) {
        for (const kw of keywords) {
          try {
            // Search channels
            const searchRes = await fetch(
              `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(kw)}&maxResults=50&key=${YOUTUBE_API_KEY}`
            );
            const searchData = await searchRes.json();
            if (searchData.error) { console.warn(`[BatchDiscovery] YouTube search error for "${kw}":`, searchData.error.message); continue; }

            const channelIds = (searchData.items || []).map(i => i.id.channelId || i.snippet.channelId).filter(Boolean);
            if (channelIds.length === 0) continue;

            // Get channel details in batch
            const statsRes = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`
            );
            const statsData = await statsRes.json();

            for (const ch of (statsData.items || [])) {
              if (seenIds.has(ch.id)) continue;
              seenIds.add(ch.id);

              const subs = parseInt(ch.statistics?.subscriberCount) || 0;
              if (subs < minSubscribers) continue;

              // Check if active in last year: use channel's upload playlist
              const uploadsPlaylistId = ch.contentDetails?.relatedPlaylists?.uploads;
              if (uploadsPlaylistId) {
                try {
                  const plRes = await fetch(
                    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&key=${YOUTUBE_API_KEY}`
                  );
                  const plData = await plRes.json();
                  const latestDate = plData.items?.[0]?.snippet?.publishedAt;
                  if (latestDate) {
                    const oneYearAgo = new Date();
                    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
                    if (new Date(latestDate) < oneYearAgo) {
                      continue; // Skip inactive channels
                    }
                  }
                } catch {}
              }

              totalFound++;

              // Check if already in kol_database
              const existing = await queryOne("SELECT id, email FROM kol_database WHERE profile_url=? OR (platform='youtube' AND username=?)",
                [`https://www.youtube.com/channel/${ch.id}`, ch.snippet.customUrl?.replace('@', '') || ch.id]);
              if (existing?.email) { totalSaved++; continue; } // Already have with email

              // Enhanced email discovery
              const description = ch.snippet.description || '';
              const email = await scraper.discoverEmail(description, '');

              if (!email) continue; // SKIP if no email found
              totalWithEmail++;

              // Full scrape for more data
              const profileUrl = `https://www.youtube.com/channel/${ch.id}`;
              const username = ch.snippet.customUrl?.replace('@', '') || ch.id;
              const videoCount = parseInt(ch.statistics?.videoCount) || 0;
              const totalViews = parseInt(ch.statistics?.viewCount) || 0;
              const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
              const category = scraper.extractEmailFromText ? discoveryAgent.calculateRelevance ? 'Gaming' : '' : '';
              const cat = detectCategoryForDiscovery(ch.snippet.title + ' ' + description);

              const kolId = existing?.id || uuidv4();
              if (usePostgres) {
                await exec(
                  `INSERT INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, total_videos, category, email, bio, country, language, scrape_status, source_campaign_id, updated_at)
                  VALUES (?, 'youtube', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'complete', 'batch-email', CURRENT_TIMESTAMP)
                  ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, followers=EXCLUDED.followers, avg_views=EXCLUDED.avg_views, total_videos=EXCLUDED.total_videos, display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url, bio=EXCLUDED.bio, updated_at=CURRENT_TIMESTAMP`,
                  [kolId, username, ch.snippet.title, ch.snippet.thumbnails?.high?.url || '', profileUrl,
                   subs, avgViews, videoCount, cat, email, description.slice(0, 500),
                   ch.snippet.country || '', ch.snippet.defaultLanguage || '']);
              } else {
                await exec(
                  `INSERT OR REPLACE INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, total_videos, category, email, bio, country, language, scrape_status, source_campaign_id, updated_at)
                  VALUES (?, 'youtube', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'complete', 'batch-email', CURRENT_TIMESTAMP)`,
                  [kolId, username, ch.snippet.title, ch.snippet.thumbnails?.high?.url || '', profileUrl,
                   subs, avgViews, videoCount, cat, email, description.slice(0, 500),
                   ch.snippet.country || '', ch.snippet.defaultLanguage || '']);
              }
              totalSaved++;
              console.log(`[BatchDiscovery] Saved YouTube: ${ch.snippet.title} (${subs} subs) - ${email}`);

              // Rate limit: YouTube API
              await new Promise(r => setTimeout(r, 200));
            }

            // Update job progress
            await exec("UPDATE discovery_jobs SET total_found=?, total_processed=? WHERE id=?", [totalFound, totalSaved, jobId]);
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            console.warn(`[BatchDiscovery] YouTube keyword "${kw}" error:`, e.message);
          }
        }
      }

      // ---- TikTok Discovery (via web search for TikTok creators) ----
      if (platforms.includes('tiktok')) {
        const tiktokKeywords = [
          'gaming AI tiktok creator', 'AI roleplay tiktok', 'gaming tiktok influencer',
          'AI game review tiktok', 'mobile game tiktok creator',
        ];
        for (const kw of tiktokKeywords) {
          try {
            // Use YouTube search to find TikTok compilation/mention channels,
            // then we search TikTok usernames found. Or search TikTok directly.
            // TikTok has no search API, so we scrape known creators from YouTube crossover.
            // For now, search YouTube for "tiktok" + keyword to find cross-platform creators
            if (!YOUTUBE_API_KEY) continue;
            const searchRes = await fetch(
              `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(kw)}&maxResults=20&key=${YOUTUBE_API_KEY}&publishedAfter=${new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()}`
            );
            const searchData = await searchRes.json();
            if (searchData.error) continue;

            // Extract TikTok usernames from video descriptions
            const videoIds = (searchData.items || []).map(i => i.id.videoId).filter(Boolean);
            if (videoIds.length === 0) continue;

            const vidRes = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
            );
            const vidData = await vidRes.json();

            for (const vid of (vidData.items || [])) {
              const desc = vid.snippet?.description || '';
              // Find TikTok URLs in description
              const tiktokUrls = desc.match(/https?:\/\/(www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/gi) || [];
              for (const ttUrl of tiktokUrls) {
                const ttUsername = ttUrl.match(/@([a-zA-Z0-9_.]+)/)?.[1];
                if (!ttUsername || seenIds.has('tt-' + ttUsername)) continue;
                seenIds.add('tt-' + ttUsername);

                // Check if already in DB
                const existing = await queryOne("SELECT id, email FROM kol_database WHERE platform='tiktok' AND username=?", [ttUsername]);
                if (existing?.email) { continue; }

                // Scrape TikTok profile
                try {
                  const profileUrl = `https://www.tiktok.com/@${ttUsername}`;
                  const result = await scraper.scrapeTikTok(profileUrl, ttUsername, { workspaceId: req.workspace?.id });
                  if (!result.success || !result.data) continue;
                  if (result.data.followers < minSubscribers) continue;

                  totalFound++;
                  const email = result.data.email || await scraper.discoverEmail(result.data.bio || '', '');
                  if (!email) continue;
                  totalWithEmail++;

                  const kolId = existing?.id || uuidv4();
                  const cat = detectCategoryForDiscovery(result.data.bio || '');
                  if (usePostgres) {
                    await exec(
                      `INSERT INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, total_videos, category, email, bio, scrape_status, source_campaign_id, updated_at)
                      VALUES (?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 'batch-email', CURRENT_TIMESTAMP)
                      ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, followers=EXCLUDED.followers, display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url, bio=EXCLUDED.bio, updated_at=CURRENT_TIMESTAMP`,
                      [kolId, ttUsername, result.data.display_name, result.data.avatar_url || '', profileUrl,
                       result.data.followers, result.data.engagement_rate, result.data.avg_views, result.data.total_videos,
                       cat, email, (result.data.bio || '').slice(0, 500)]);
                  } else {
                    await exec(
                      `INSERT OR REPLACE INTO kol_database (id, platform, username, display_name, avatar_url, profile_url, followers, engagement_rate, avg_views, total_videos, category, email, bio, scrape_status, source_campaign_id, updated_at)
                      VALUES (?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 'batch-email', CURRENT_TIMESTAMP)`,
                      [kolId, ttUsername, result.data.display_name, result.data.avatar_url || '', profileUrl,
                       result.data.followers, result.data.engagement_rate, result.data.avg_views, result.data.total_videos,
                       cat, email, (result.data.bio || '').slice(0, 500)]);
                  }
                  totalSaved++;
                  console.log(`[BatchDiscovery] Saved TikTok: @${ttUsername} (${result.data.followers} followers) - ${email}`);
                } catch (e) {
                  console.warn(`[BatchDiscovery] TikTok @${ttUsername} error:`, e.message);
                }
                await new Promise(r => setTimeout(r, 1000)); // TikTok rate limit
              }
            }
            await exec("UPDATE discovery_jobs SET total_found=?, total_processed=? WHERE id=?", [totalFound, totalSaved, jobId]);
          } catch (e) {
            console.warn(`[BatchDiscovery] TikTok keyword "${kw}" error:`, e.message);
          }
        }
      }

      // Final update
      await exec("UPDATE discovery_jobs SET status='complete', total_found=?, total_processed=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
        [totalFound, totalSaved, jobId]);
      console.log(`[BatchDiscovery ${jobId}] Complete. Found: ${totalFound}, With Email: ${totalWithEmail}, Saved: ${totalSaved}`);
    })().catch(async (e) => {
      console.error(`[BatchDiscovery ${jobId}] Fatal error:`, e.message);
      await exec("UPDATE discovery_jobs SET status='error', completed_at=CURRENT_TIMESTAMP WHERE id=?", [jobId]).catch(() => {});
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function detectCategoryForDiscovery(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const cats = [
    { name: 'Gaming', kw: ['game', 'gaming', 'gamer', 'esport', 'play', 'streamer', 'fps', 'rpg', 'moba'] },
    { name: 'AI', kw: ['ai', 'artificial intelligence', 'roleplay', 'character ai', 'npc', 'chatbot'] },
    { name: 'Tech', kw: ['tech', 'technology', 'software', 'code', 'review', 'gadget'] },
    { name: 'Entertainment', kw: ['entertainment', 'comedy', 'vlog', 'content creator'] },
  ];
  let best = { name: '', score: 0 };
  for (const c of cats) { const s = c.kw.filter(k => lower.includes(k)).length; if (s > best.score) best = { name: c.name, score: s }; }
  return best.name;
}

// SPA fallback - use middleware approach for Express 5 compatibility
app.use(BASE_PATH, (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// ==================== Auto-setup on startup ====================
// Idempotent: make sure the user owns at least one workspace. Returns the
// workspace_id of an existing membership if any, otherwise creates a new
// workspace (and membership as admin) and returns its id. Used at login,
// auth/me, and after invite-code redemption so a brand-new user never lands
// in an "no workspace" limbo state that breaks every /api/* call.
async function ensureUserHasWorkspace(userId, displayName) {
  const existing = await queryOne(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (existing) return existing.workspace_id;

  const wsId = uuidv4();
  const baseName = (displayName || 'My').toString().split('@')[0];
  const slug = (baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'workspace')
    + '-' + wsId.replace(/-/g, '').slice(0, 6);
  const wsName = `${baseName}'s workspace`;
  await exec(
    'INSERT INTO workspaces (id, name, slug, owner_user_id, plan) VALUES (?, ?, ?, ?, ?)',
    [wsId, wsName, slug, userId, 'starter']
  );
  await exec(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
    [wsId, userId, 'admin']
  );
  log.info(`[onboarding] auto-created workspace "${wsName}" for user ${userId}`);
  return wsId;
}

async function initializeDefaultData() {
  // Create default admin account from env vars (skip if not configured).
  // Promotes the user to role='admin' so they can manage invite codes and
  // perform other platform-admin actions. If the user already exists but
  // isn't an admin, we still upgrade them — env vars are the source of truth.
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || 'Admin';
  if (adminEmail && adminPassword) {
    const existing = await queryOne('SELECT id, role FROM users WHERE email = ?', [adminEmail]);
    let userId;
    if (!existing) {
      const created = await registerUser(adminEmail, adminPassword, adminName);
      if (!created.error) {
        await exec('UPDATE users SET role = ? WHERE id = ?', ['admin', created.id]);
        userId = created.id;
        console.log(`Default admin account created: ${adminEmail}`);
      }
    } else {
      userId = existing.id;
      if (existing.role !== 'admin') {
        await exec('UPDATE users SET role = ? WHERE id = ?', ['admin', existing.id]);
        console.log(`Promoted ${adminEmail} to admin role`);
      }
    }
    // Make sure the bootstrap admin always has a workspace they own. Without
    // this, the first login lands in "no workspace" limbo and every page
    // breaks with `Workspace context required`.
    if (userId) {
      await ensureUserHasWorkspace(userId, adminName);
    }
  }

  // Seed demo campaign if no campaigns exist
  const campaignCount = await queryOne('SELECT COUNT(*) as count FROM campaigns');
  if (parseInt(campaignCount.count) === 0) {
    await seedDemoData();
    console.log('Demo data seeded: HakkoAI_Q1_All campaign');
  }
}

// Start server after database initialization
(async () => {
  try {
    await initializeDatabase();
    const migrationResult = await runPendingMigrations({ query, queryOne, exec });
    if (migrationResult.applied > 0) {
      console.log(`[migrations] Applied ${migrationResult.applied} migration(s), total ${migrationResult.total}`);
    }
    await initializeDefaultData();
    app.listen(PORT, () => {
      console.log(`InfluenceX server running on port ${PORT} (${usePostgres ? 'PostgreSQL' : 'SQLite'})`);
      console.log(`Access at: http://localhost:${PORT}${BASE_PATH}/`);
      // Register background handlers on the shared job queue.
      emailJobs.register({ jobQueue, query, queryOne, exec, mailAgent });
      // Safety-net sweep every 10 minutes: fail contacts stuck in 'pending'.
      setInterval(() => {
        try { jobQueue.push('email.sync_status', {}, { maxRetries: 0 }); } catch {}
      }, 10 * 60 * 1000).unref?.();
      scheduler.start({ query, exec, queryOne, mailAgent, uuidv4, jobQueue });
      scheduledPublish.start({
        query, queryOne, exec, uuidv4, publishOauth, agentRuntime,
      });
      apifyWatchdog.start({ exec, query });
      // Register all v2 agents with the runtime
      const registered = agentsV2.registerAll();
      console.log(`[agents-v2] Registered ${registered.length} agents: ${registered.join(', ')}`);
    });
  } catch (e) {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  }
})();

// ==================== Helper Functions ====================

function generateSampleKols(platforms, count, criteria) {
  const names = {
    tiktok: ['GamingPro_TT', 'TechReview_TT', 'CasualGamer_TT', 'MobileGaming_TT', 'StreamerX_TT', 'PlayDaily_TT', 'GameTips_TT', 'ProPlayer_TT', 'RetroGames_TT', 'IndieGamer_TT', 'EsportsKing_TT', 'GameDevTT', 'SpeedrunTT', 'RPGMaster_TT', 'FPSElite_TT'],
    youtube: ['GameVault_YT', 'TechGaming_YT', 'PixelPlays_YT', 'NextLevelYT', 'GameAnalyst_YT', 'ProGuides_YT', 'GameNews_YT', 'LetsPlay_YT', 'TopTenGaming_YT', 'GamerZone_YT', 'ReviewBoss_YT', 'WalkthroughYT', 'GameTrailers_YT', 'CriticalHit_YT', 'BossLevel_YT'],
    instagram: ['game.vibes', 'tech.gamer', 'mobile.plays', 'gaming.daily', 'pro.gamer.ig', 'game.clips', 'esports.ig', 'gamer.life', 'play.more.ig', 'game.art.ig', 'cosplay.gamer', 'stream.highlights', 'game.memes', 'retro.gaming', 'indie.spotlight'],
    twitch: ['StreamKing_TV', 'ProStreamer_TV', 'CasualStream_TV', 'GameLive_TV', 'TwitchPro_TV', 'LiveGamer_TV', 'ChillStreams_TV', 'CompetitiveTTV', 'CozyGamerTTV', 'SpeedGameTTV', 'RaidBoss_TV', 'ArenaKing_TV', 'DungeonTTV', 'PvPMaster_TV', 'QuestLive_TV'],
    x: ['GameTalkX', 'TechGamerX', 'GamingNewsX', 'ProGamerX', 'IndieDevX', 'EsportsX', 'RetroX', 'GameDealsX', 'StreamAlertX', 'GameUpdateX', 'PatchNotesX', 'MetaGamerX', 'RankedX', 'LootDropX', 'BetaTestX']
  };
  const categories = ['Gaming', 'Tech', 'Entertainment', 'Lifestyle', 'Education'];
  const kols = [];
  const activePlatforms = platforms.length > 0 ? platforms : ['tiktok', 'youtube', 'instagram'];

  for (let i = 0; i < count; i++) {
    const platform = activePlatforms[i % activePlatforms.length];
    const platformNames = names[platform] || names.tiktok;
    const username = platformNames[i % platformNames.length] + '_' + Math.floor(Math.random() * 999);
    const followers = Math.floor(Math.random() * 900000) + (criteria.min_followers || 10000);
    const engagement = (Math.random() * 8 + 1).toFixed(2);
    const avgViews = Math.floor(followers * (parseFloat(engagement) / 100) * (Math.random() * 3 + 1));

    kols.push({
      id: uuidv4(),
      platform,
      username,
      display_name: username.replace(/_/g, ' ').replace(/\d+$/, '').trim(),
      avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
      followers,
      engagement_rate: parseFloat(engagement),
      avg_views: avgViews,
      category: categories[Math.floor(Math.random() * categories.length)],
      email: `${username.toLowerCase().replace(/[^a-z0-9]/g, '')}@email.com`,
      contact_info: {},
      profile_url: `https://${platform}.com/@${username}`,
      bio: `Content creator on ${platform}. ${followers > 100000 ? 'Major' : 'Rising'} influencer in ${categories[Math.floor(Math.random() * categories.length)]}.`
    });
  }
  return kols;
}

// Template fallback used when no LLM is configured or an LLM call fails.
// Kept separate so it can be inlined in the LLM path as the last resort.
function generateOutreachEmailTemplate(kol, campaign, cooperationType, priceQuote) {
  const displayName = kol.display_name || kol.username;
  const isAffiliate = cooperationType === 'affiliate';

  const subject = `Collaboration Opportunity - ${campaign.name} x ${displayName}`;
  const body = `Hi ${displayName},

I hope this message finds you well! I've been following your content on ${kol.platform} and I'm really impressed by your work, especially your engagement with your ${kol.followers > 100000 ? kol.followers.toLocaleString() + '+' : 'growing'} audience.

I'm reaching out from the ${campaign.name} team. ${campaign.description || 'We are looking for talented content creators to collaborate with.'}

${isAffiliate ? `We'd love to invite you to join our affiliate program. Here's how it works:
- Sign up at: https://www.hakko.ai/affiliates
- Earn commission on every referral
- Access to exclusive promotional materials
- Monthly payouts with transparent tracking` : `We'd like to propose a paid collaboration:
- Content format: Sponsored video/post about ${campaign.name}
- Compensation: ${priceQuote || 'Negotiable based on deliverables'}
- Timeline: Flexible, within the next 2-4 weeks`}

${priceQuote && !isAffiliate ? `\nBudget for this collaboration: ${priceQuote}\n` : ''}
We believe your audience would genuinely benefit from knowing about our product. Would you be interested in discussing this further?

Looking forward to hearing from you!

Best regards,
${campaign.name} Partnership Team`;

  return { subject, body };
}

// LLM-powered outreach email generator. Calls the default LLM provider to
// produce a personalized subject + body per KOL. Falls back silently to the
// template when no LLM is configured, the LLM times out, or the response
// can't be parsed. Callers get a consistent { subject, body } shape either
// way. Was previously pure template — see Bug #9 in KOL_FLOW_TEST_2026-04.
async function generateOutreachEmail(kol, campaign, cooperationType, priceQuote) {
  const templateOut = generateOutreachEmailTemplate(kol, campaign, cooperationType, priceQuote);

  if (!llm.isConfigured()) return templateOut;

  const displayName = kol.display_name || kol.username;
  const followerText = kol.followers
    ? (kol.followers >= 1000 ? kol.followers.toLocaleString() : String(kol.followers))
    : 'unknown';
  const isAffiliate = cooperationType === 'affiliate';

  const system = `You write concise, personalized B2B outreach emails to social media creators. Each email must:
- Open with a specific, genuine observation about THIS creator (use their niche, follower count, engagement, bio — not generic flattery).
- Be 110–160 words. Short paragraphs.
- Make a clear, actionable ask tied to the campaign's cooperation type.
- Avoid emoji and avoid the phrase "I hope this message finds you well".
- Sign off as "${campaign.name} Partnership Team".
Output must be a single JSON object with exactly two string fields: "subject" and "body". No markdown, no prose outside JSON.`;

  const cooperationBlurb = isAffiliate
    ? `Affiliate program — revenue share on referrals. Signup URL: https://www.hakko.ai/affiliates`
    : `Paid collaboration. Budget: ${priceQuote || 'negotiable'}. Deliverable: sponsored video/post.`;

  const user = `Creator:
- Name: ${displayName}
- Platform: ${kol.platform}
- Followers: ${followerText}
- Category: ${kol.category || 'unspecified'}
- Engagement rate: ${kol.engagement_rate != null ? kol.engagement_rate + '%' : 'unknown'}
- Avg views: ${kol.avg_views != null ? kol.avg_views.toLocaleString() : 'unknown'}
- Bio: ${(kol.bio || '').slice(0, 300)}

Campaign:
- Name: ${campaign.name}
- Description: ${campaign.description || '(no description)'}

Cooperation type: ${cooperationType || 'affiliate'}
${cooperationBlurb}

Write the outreach email. Respond with JSON only.`;

  try {
    const res = await llm.complete({
      messages: [{ role: 'user', content: user }],
      system,
      maxTokens: 600,
      temperature: 0.6,
    });
    const raw = (res.text || '').trim();
    // Best-effort JSON extraction: some models wrap in ``` fences despite instructions.
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) throw new Error('no JSON object in response');
    const parsed = JSON.parse(jsonStr);
    if (!parsed.subject || !parsed.body) throw new Error('missing subject/body in LLM output');
    return { subject: String(parsed.subject).trim(), body: String(parsed.body).trim(), generator: 'llm' };
  } catch (e) {
    console.warn('[outreach-email] LLM failed, falling back to template:', e.message);
    return templateOut;
  }
}

function calculateAIScore(kol, criteria, campaignDesc) {
  let score = 50; // base score
  const reasons = [];

  // Engagement rate scoring (higher is much better)
  if (kol.engagement_rate >= 5) { score += 20; reasons.push('Excellent engagement rate'); }
  else if (kol.engagement_rate >= 3) { score += 12; reasons.push('Good engagement rate'); }
  else if (kol.engagement_rate >= 1.5) { score += 5; reasons.push('Average engagement'); }
  else { score -= 5; reasons.push('Low engagement'); }

  // Follower count scoring
  if (kol.followers >= 500000) { score += 10; reasons.push('Large audience reach'); }
  else if (kol.followers >= 100000) { score += 15; reasons.push('Strong mid-tier reach'); }
  else if (kol.followers >= 30000) { score += 12; reasons.push('Focused niche audience'); }
  else { score += 5; reasons.push('Micro-influencer'); }

  // Category match (if criteria has categories)
  const cats = (criteria.categories || '').toLowerCase();
  if (cats && kol.category) {
    if (cats.includes(kol.category.toLowerCase())) {
      score += 15; reasons.push(`Category match: ${kol.category}`);
    }
  }

  // Platform preference bonus
  const descLower = (campaignDesc || '').toLowerCase();
  if (descLower.includes('gaming') && ['twitch', 'youtube'].includes(kol.platform)) {
    score += 8; reasons.push('Gaming-oriented platform');
  }
  if (descLower.includes('short') && ['tiktok', 'instagram'].includes(kol.platform)) {
    score += 8; reasons.push('Short-form content platform');
  }

  // Cost efficiency (views per follower ratio)
  const viewRatio = kol.avg_views / Math.max(kol.followers, 1);
  if (viewRatio > 0.15) { score += 10; reasons.push('High view-to-follower ratio'); }
  else if (viewRatio > 0.05) { score += 5; }

  // Clamp score
  score = Math.min(99, Math.max(10, score));

  // Estimate CPM based on platform and followers
  const baseCpm = { tiktok: 8, youtube: 15, instagram: 10, twitch: 12, x: 6 };
  const platformCpm = baseCpm[kol.platform] || 10;
  const followerMultiplier = kol.followers > 500000 ? 1.8 : kol.followers > 100000 ? 1.3 : 1.0;
  const estimatedCpm = +(platformCpm * followerMultiplier).toFixed(2);

  return {
    score,
    reason: reasons.slice(0, 3).join(' | '),
    estimatedCpm
  };
}

function extractUsernameFromUrl(url, platform) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    // Handle common patterns: /@username, /c/channel, /channel/name, /username
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return url;

    let last = segments[segments.length - 1];
    // TikTok/Instagram: /@username
    if (last.startsWith('@')) return last.slice(1);
    // YouTube: /c/name, /channel/ID, /@name
    if (platform === 'youtube') {
      if (segments.length >= 2 && (segments[0] === 'c' || segments[0] === 'channel')) return segments[1];
      if (last.startsWith('@')) return last.slice(1);
    }
    return last;
  } catch {
    // Fallback: extract anything after @ or last segment
    const atMatch = url.match(/@([a-zA-Z0-9._-]+)/);
    if (atMatch) return atMatch[1];
    return url.split('/').filter(Boolean).pop() || url;
  }
}

async function scrapeAndEnrichKol(id, profileUrl, platform, username) {
  try {
    // Use real APIs to fetch profile data
    const result = await scraper.scrapeProfile(profileUrl, platform, username, { workspaceId: req.workspace?.id });

    if (!result.success) {
      // API not configured or failed - mark with error, don't generate fake data
      await exec("UPDATE kol_database SET scrape_status='error', scrape_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [result.error, id]);
      console.warn(`Scrape failed for ${username} (${platform}): ${result.error}`);
      return;
    }

    const d = result.data;

    // Calculate AI brand-fit score based on real data
    const score = calculateAIScore(
      { platform, followers: d.followers, engagement_rate: d.engagement_rate, avg_views: d.avg_views, category: d.category },
      { min_followers: 10000, min_engagement: 2, categories: 'Gaming, Tech, AI' },
      'Gaming and Tech KOL campaign'
    );

    // Generate outreach email based on real profile data
    const emailContent = await generateOutreachEmail(
      { display_name: d.display_name || username, platform, followers: d.followers, username },
      { name: 'HakkoAI', description: 'Hakko AI - Next-gen AI gaming assistant' },
      'affiliate', ''
    );

    const scrapeStatus = result.partial ? 'partial' : 'complete';

    await exec(`UPDATE kol_database SET
      display_name=?, avatar_url=?, followers=?, following=?, engagement_rate=?,
      avg_views=?, total_videos=?, category=?, email=?, bio=?, country=?, language=?,
      ai_score=?, ai_reason=?, estimated_cpm=?,
      outreach_email_subject=?, outreach_email_body=?,
      scrape_status=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`,
      [
        d.display_name || username,
        d.avatar_url || '',
        d.followers || 0,
        d.following || 0,
        d.engagement_rate || 0,
        d.avg_views || 0,
        d.total_videos || 0,
        d.category || '',
        d.email || '',
        d.bio || '',
        d.country || '',
        d.language || '',
        score.score,
        score.reason,
        score.estimatedCpm,
        emailContent.subject,
        emailContent.body,
        scrapeStatus,
        id
      ]);
    console.log(`Scraped KOL (real): ${d.display_name || username} (${platform}) - ${d.followers} followers, score: ${score.score}`);
  } catch (e) {
    await exec("UPDATE kol_database SET scrape_status='error', scrape_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [e.message, id]);
    console.error(`Scrape error for ${username}:`, e.message);
  }
}

async function seedDemoData() {
  const CAMPAIGN_ID = 'hakko-q1-all';

  if (usePostgres) {
    await exec(
      `INSERT INTO campaigns (id, name, description, platforms, daily_target, filter_criteria, budget, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, platforms=EXCLUDED.platforms, daily_target=EXCLUDED.daily_target, filter_criteria=EXCLUDED.filter_criteria, budget=EXCLUDED.budget, status=EXCLUDED.status`,
      [
        CAMPAIGN_ID,
        'HakkoAI_Q1_All',
        'Hakko AI Q1 2026 全平台达人推广 - Gaming & Tech KOL outreach campaign for hakko.ai product launch',
        JSON.stringify(['tiktok', 'youtube', 'instagram', 'twitch', 'x']),
        15,
        JSON.stringify({ min_followers: 10000, min_engagement: 2, categories: 'Gaming, Tech, Entertainment, AI' }),
        50000,
        'active'
      ]
    );
  } else {
    await exec(
      `INSERT OR REPLACE INTO campaigns (id, name, description, platforms, daily_target, filter_criteria, budget, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        CAMPAIGN_ID,
        'HakkoAI_Q1_All',
        'Hakko AI Q1 2026 全平台达人推广 - Gaming & Tech KOL outreach campaign for hakko.ai product launch',
        JSON.stringify(['tiktok', 'youtube', 'instagram', 'twitch', 'x']),
        15,
        JSON.stringify({ min_followers: 10000, min_engagement: 2, categories: 'Gaming, Tech, Entertainment, AI' }),
        50000,
        'active'
      ]
    );
  }
}
