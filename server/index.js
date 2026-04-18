require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const { query, queryOne, exec, transaction, initializeDatabase, usePostgres, getQueryStats, scoped } = require('./database');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware, registerUser, loginUser, destroySession, getSession } = require('./auth');
const { workspaceContext, listUserWorkspaces, getDefaultWorkspaceId } = require('./workspace-middleware');
const ga4 = require('./ga4');
const feishu = require('./feishu');
const scraper = require('./scraper');
const mailAgent = require('./agents/mail-agent');
const dataAgent = require('./agents/data-agent');
const discoveryAgent = require('./agents/discovery-agent');
const youtubeQuota = require('./youtube-quota');
const { runPendingMigrations } = require('./migrations');
const emailTemplates = require('./email-templates');
const csvExport = require('./csv-export');
const rbac = require('./rbac');
const notifications = require('./notifications');
const scheduler = require('./scheduler');
const { rateLimit } = require('./rate-limit');
const { registerHealthRoutes } = require('./health');
const { getCampaignRoi } = require('./roi-dashboard');
const { buildOpenApiSpec, swaggerUiHtml } = require('./openapi');
const agentRuntime = require('./agent-runtime');
const conductor = require('./agent-runtime/conductor');
const agentsV2 = require('./agents-v2');
const llm = require('./llm');
const { createQueue } = require('./job-queue');
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
app.use((req, res, next) => {
  if (req.path === `${BASE_PATH}/api/webhooks/resend/inbound`) {
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; }
    })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

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
registerHealthRoutes(app, BASE_PATH, { query, usePostgres, youtubeQuota, notifications });

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

// ==================== Auth API ====================

app.post(`${BASE_PATH}/api/auth/register`, authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const result = await registerUser(email, password, name);
    if (result.error) return res.status(400).json({ error: result.error });
    // Auto-login after registration
    const login = await loginUser(email, password);
    res.json(login);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE_PATH}/api/auth/login`, authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const result = await loginUser(email, password);
    if (result.error) return res.status(401).json({ error: result.error });

    // Enrich with workspace info so the client can populate the switcher
    // immediately and the session has a default workspace to scope requests.
    const workspaces = await listUserWorkspaces(result.user.id);
    const currentWorkspaceId = workspaces[0]?.id || null;

    res.json({ ...result, workspaces, currentWorkspaceId });
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
    const workspaces = await listUserWorkspaces(user.id);
    const currentWorkspaceId = workspaces[0]?.id || null;
    res.json({ ...user, workspaces, currentWorkspaceId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    if (!invitee) return res.status(404).json({ error: 'User not found. They must register first.' });

    const existing = await queryOne(
      'SELECT 1 as x FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.params.id, invitee.id]
    );
    if (existing) return res.status(409).json({ error: 'Already a member' });

    await exec(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)',
      [req.params.id, invitee.id, role, req.user.id]
    );
    res.json({ success: true, user_id: invitee.id, role });
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
  // SSE streams authenticate via query-string (EventSource can't set headers)
  if (/^\/agents\/runs\/[^/]+\/stream$/.test(req.path)) return next();
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
  '/notifications/', '/quota/', '/cache/', '/queue/', '/apify/',
  '/query/', '/scheduler/', '/email-templates', '/stats',
];
app.use(`${BASE_PATH}/api`, (req, res, next) => {
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
    let sql = `SELECT c.*, k.username, k.display_name, k.platform, k.avatar_url, k.followers, k.email as kol_email
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

    const email = generateOutreachEmail(kol, campaign, cooperation_type || 'affiliate', price_quote);
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
            payment_amount, payment_status } = req.body;
    const s = scoped(req.workspace.id);
    const result = await s.exec(
      `UPDATE contacts SET email_subject=?, email_body=?, cooperation_type=?, price_quote=?, notes=?,
       contract_status=COALESCE(?, contract_status), contract_url=COALESCE(?, contract_url),
       content_status=COALESCE(?, content_status), content_url=COALESCE(?, content_url),
       content_due_date=COALESCE(?, content_due_date),
       payment_amount=COALESCE(?, payment_amount), payment_status=COALESCE(?, payment_status) WHERE id=? AND workspace_id=?`,
      [email_subject, email_body, cooperation_type, price_quote, notes,
        contract_status || null, contract_url || null,
        content_status || null, content_url || null, content_due_date || null,
        payment_amount || null, payment_status || null, req.params.id, req.workspace.id]
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
    params.push(req.params.id);
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

// Send email (actually send via Resend/SMTP)
app.post(`${BASE_PATH}/api/contacts/:id/send`, sendEmailLimiter, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    // Load contact + KOL email address (scoped to current workspace)
    const contact = await s.queryOne(
      `SELECT c.*, k.email as kol_email, k.display_name, k.username
       FROM contacts c JOIN kols k ON c.kol_id = k.id
       WHERE c.id = ? AND c.workspace_id = ?`,
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const emailTo = req.body.email_to || contact.kol_email;
    if (!emailTo) {
      return res.status(400).json({ error: 'No recipient email address found for this KOL' });
    }
    if (!contact.email_subject || !contact.email_body) {
      return res.status(400).json({ error: 'Email subject/body is empty — generate or edit first' });
    }

    // If email provider not configured, fall back to marking as sent (dev mode)
    if (!mailAgent.isConfigured()) {
      await s.exec(
        "UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
        [req.params.id, req.workspace.id]
      );
      return res.json({
        success: true,
        message: 'Email marked as sent (email provider not configured — no actual send)',
        dryRun: true,
      });
    }

    // Actually send
    const sendResult = await mailAgent.sendEmail({
      to: emailTo,
      subject: contact.email_subject,
      body: contact.email_body,
    });

    if (!sendResult.success) {
      return res.status(502).json({ error: sendResult.error || 'Email provider rejected the send' });
    }

    // Update contact + record outbound email in thread
    await s.exec(
      "UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [req.params.id, req.workspace.id]
    );
    const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || 'noreply@localhost';
    await s.exec(
      "INSERT INTO email_replies (id, workspace_id, contact_id, direction, from_email, to_email, subject, body_text, resend_email_id, received_at) VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      [uuidv4(), req.workspace.id, req.params.id, fromEmail, emailTo, contact.email_subject, contact.email_body, sendResult.messageId]
    );

    res.json({ success: true, messageId: sendResult.messageId, provider: sendResult.provider });
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

    // Update contact status
    if (contactId) {
      await exec("UPDATE contacts SET status='replied', reply_content=?, reply_at=CURRENT_TIMESTAMP WHERE id=?",
        [bodyText.substring(0, 2000), contactId]);
    }

    // Save the full reply
    await exec(
      "INSERT INTO email_replies (id, contact_id, pipeline_job_id, direction, from_email, to_email, subject, body_text, body_html, in_reply_to, received_at) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      [uuidv4(), contactId, pipelineJobId, fromEmail, toEmail, subject || '', bodyText, bodyHtml, inReplyTo]
    );

    console.log(`[Inbound Email] Saved. contact_id=${contactId}, pipeline_job_id=${pipelineJobId}`);

    // Fire notification (fire-and-forget)
    notifications.events.emailReply({
      kolName: fromEmail,
      subject: subject || '(no subject)',
      preview: bodyText,
    });

    res.json({ success: true, contactId, pipelineJobId });
  } catch (e) {
    console.error('[Inbound Email] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get email thread for a contact
app.get(`${BASE_PATH}/api/contacts/:id/thread`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const contact = await s.queryOne(
      "SELECT c.*, k.name as kol_name, k.email as kol_email FROM contacts c LEFT JOIN kols k ON c.kol_id=k.id WHERE c.id=? AND c.workspace_id=?",
      [req.params.id, req.workspace.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Get all email exchanges
    const replies = await s.query(
      "SELECT * FROM email_replies WHERE contact_id=? AND workspace_id=? ORDER BY received_at ASC",
      [req.params.id, req.workspace.id]
    );

    // Build thread: outbound (our sent email) + inbound replies
    const thread = [];

    // Add the original outbound email
    if (contact.email_subject) {
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

    // Add all replies
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

    res.json({ contact, thread });
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
    const campaign = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.campaignId]);
    const approvedResult = await query("SELECT * FROM kols WHERE campaign_id = ? AND status = 'approved'", [req.params.campaignId]);
    const approvedKols = approvedResult.rows;

    // Filter out KOLs that already have contacts
    const existingResult = await query('SELECT kol_id FROM contacts WHERE campaign_id = ?', [req.params.campaignId]);
    const existingKolIds = existingResult.rows.map(r => r.kol_id);
    const newKols = approvedKols.filter(k => !existingKolIds.includes(k.id));

    const results = await transaction(async (tx) => {
      const txResults = [];
      for (const kol of newKols) {
        const email = generateOutreachEmail(kol, campaign, cooperation_type || 'affiliate', price_quote);
        const id = uuidv4();
        await tx.exec(
          'INSERT INTO contacts (id, kol_id, campaign_id, email_subject, email_body, cooperation_type, price_quote, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, kol.id, req.params.campaignId, email.subject, email.body, cooperation_type || 'affiliate', price_quote || '', 'draft']
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

// ==================== GA4 Analytics API ====================

// GA4 helper: wrap calls with a timeout so gRPC issues don't hang the request
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('GA4 timeout')), ms)),
  ]);
}

app.get(`${BASE_PATH}/api/data/ga4/metrics`, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (ga4.isConfigured()) {
    try {
      const data = await withTimeout(ga4.getWebsiteMetrics(startDate, endDate));
      res.json(data);
    } catch (e) {
      console.warn('GA4 metrics error:', e.message);
      res.json({ configured: true, error: e.message, data: [], totals: {} });
    }
  } else {
    res.json(ga4.getDemoMetrics());
  }
});

app.get(`${BASE_PATH}/api/data/ga4/traffic`, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (ga4.isConfigured()) {
    try {
      const data = await withTimeout(ga4.getTrafficSources(startDate, endDate));
      res.json(data);
    } catch (e) {
      console.warn('GA4 traffic error:', e.message);
      res.json({ configured: true, error: e.message, data: [] });
    }
  } else {
    res.json(ga4.getDemoTrafficSources());
  }
});

app.get(`${BASE_PATH}/api/data/ga4/realtime`, async (req, res) => {
  if (ga4.isConfigured()) {
    try {
      const data = await withTimeout(ga4.getRealtimeUsers());
      res.json(data);
    } catch (e) {
      console.warn('GA4 realtime error:', e.message);
      res.json({ configured: true, error: e.message, activeUsers: 0 });
    }
  } else {
    res.json({ configured: false, demo: true, activeUsers: Math.floor(Math.random() * 15 + 3) });
  }
});

app.get(`${BASE_PATH}/api/data/ga4/status`, (req, res) => {
  res.json({
    configured: ga4.isConfigured(),
    measurementId: ga4.GA4_MEASUREMENT_ID,
    propertyId: process.env.GA4_PROPERTY_ID || null,
  });
});

// ==================== Feishu Sync API ====================

app.get(`${BASE_PATH}/api/data/feishu/status`, (req, res) => {
  res.json({
    configured: feishu.isConfigured(),
    source: 'feishu_spreadsheet',
    sheet: '记录已发布达人内容',
  });
});

app.post(`${BASE_PATH}/api/data/feishu/sync`, async (req, res) => {
  if (!feishu.isConfigured()) return res.json({ configured: false, error: 'Feishu not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.' });

  try {
    const [contentResult, regResult] = await Promise.all([
      feishu.fetchPublishedContent(),
      feishu.fetchRegistrationData(),
    ]);

    // Store content data in local DB
    if (contentResult.configured && contentResult.data.length > 0) {
      await exec('DELETE FROM content_data');
      if (usePostgres) {
        await transaction(async (tx) => {
          for (const c of contentResult.data) {
            await tx.exec(
              'INSERT INTO content_data (id, kol_name, platform, content_title, content_url, publish_date, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kol_name=EXCLUDED.kol_name, platform=EXCLUDED.platform, content_title=EXCLUDED.content_title, content_url=EXCLUDED.content_url, publish_date=EXCLUDED.publish_date, views=EXCLUDED.views, likes=EXCLUDED.likes, comments=EXCLUDED.comments, shares=EXCLUDED.shares',
              [uuidv4(), '', c.platform, '', c.content_url, c.publish_date || '', 0, 0, 0, 0]
            );
          }
        });
      } else {
        await transaction(async (tx) => {
          for (const c of contentResult.data) {
            await tx.exec(
              'INSERT OR REPLACE INTO content_data (id, kol_name, platform, content_title, content_url, publish_date, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [uuidv4(), '', c.platform, '', c.content_url, c.publish_date || '', 0, 0, 0, 0]
            );
          }
        });
      }
    }

    // Store registration data in local DB
    if (regResult.configured && regResult.data.length > 0) {
      await exec('DELETE FROM registration_data');
      if (usePostgres) {
        await transaction(async (tx) => {
          for (const r of regResult.data) {
            await tx.exec(
              'INSERT INTO registration_data (id, date, registrations, source) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET date=EXCLUDED.date, registrations=EXCLUDED.registrations, source=EXCLUDED.source',
              [r.date, r.date, r.total, 'feishu']
            );
          }
        });
      } else {
        await transaction(async (tx) => {
          for (const r of regResult.data) {
            await tx.exec(
              'INSERT OR REPLACE INTO registration_data (id, date, registrations, source) VALUES (?, ?, ?, ?)',
              [r.date, r.date, r.total, 'feishu']
            );
          }
        });
      }
    }

    res.json({
      success: true,
      content_total: contentResult.data?.length || 0,
      registration_total: regResult.data?.length || 0,
      syncedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Full Feishu data endpoint
app.get(`${BASE_PATH}/api/data/feishu/all`, async (req, res) => {
  if (!feishu.isConfigured()) return res.json({ configured: false, error: 'Feishu not configured' });
  try {
    const [content, summary, registration] = await Promise.all([
      feishu.fetchPublishedContent(),
      feishu.getContentSummary(),
      feishu.fetchRegistrationData(),
    ]);
    res.json({
      success: true,
      summary,
      content: content.data || [],
      registration: registration.data || [],
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
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
    const result = await scheduler.tick({ query, exec, queryOne, mailAgent, notifications, uuidv4 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Notification sinks status
app.get(`${BASE_PATH}/api/notifications/status`, (req, res) => {
  res.json({ enabled_sinks: notifications.getEnabledSinks() });
});

// ==================== Agent Runtime API (Phase A Week 2) ====================

// List all registered agents
app.get(`${BASE_PATH}/api/agents`, (req, res) => {
  res.json({ agents: agentRuntime.listAgents() });
});

// Get a single agent's metadata
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
    });

    const wsId = req.workspace?.id || null;
    await exec(
      'INSERT INTO agent_runs (id, workspace_id, agent_id, user_id, input, status, cost_usd_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [runId, wsId, req.params.id, req.user?.id || null, JSON.stringify(req.body || {}), 'running', estimate.usdCents || 0]
    );

    // Attach listener that persists trace events + final status.
    // Listener runs in background — we return runId to the client right away.
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

// List agent runs in the current workspace
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

// Cost summary for the current workspace
app.get(`${BASE_PATH}/api/agents/cost`, async (req, res) => {
  try {
    const s = scoped(req.workspace.id);
    const today = new Date().toISOString().slice(0, 10);
    const [all, todayRow, byAgent] = await Promise.all([
      s.queryOne('SELECT COUNT(*) as runs, COALESCE(SUM(cost_usd_cents),0) as cents, COALESCE(SUM(input_tokens),0) as in_t, COALESCE(SUM(output_tokens),0) as out_t FROM agent_runs WHERE workspace_id = ?', [req.workspace.id]),
      s.queryOne(`SELECT COUNT(*) as runs, COALESCE(SUM(cost_usd_cents),0) as cents FROM agent_runs WHERE workspace_id = ? AND substr(started_at, 1, 10) = ?`, [req.workspace.id, today]),
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

  const scrapeResult = await scraper.scrapeProfile(profileUrl, platform, username);

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

  const emailContent = generateOutreachEmail(
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
app.post(`${BASE_PATH}/api/pipeline/jobs/:id/approve`, async (req, res) => {
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

    // Mark as approved
    await s.exec(
      "UPDATE pipeline_jobs SET email_approved=1, email_to=?, stage='send', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
      [emailTo, job.id, req.workspace.id]
    );

    // === Stage 3: SEND ===
    if (!mailAgent.isConfigured()) {
      await s.exec(
        "UPDATE pipeline_jobs SET stage='review', error='SMTP not configured', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
        [job.id, req.workspace.id]
      );
      return res.json({ success: false, error: 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS env vars.' });
    }

    const sendResult = await mailAgent.sendEmail({
      to: emailTo,
      subject: job.email_subject,
      body: job.email_body,
    });

    if (sendResult.success) {
      await s.exec(
        "UPDATE pipeline_jobs SET email_sent_at=CURRENT_TIMESTAMP, smtp_message_id=?, stage='monitor', updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
        [sendResult.messageId, job.id, req.workspace.id]
      );

      // Update contact status
      if (job.contact_id) {
        await s.exec(
          "UPDATE contacts SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
          [job.contact_id, req.workspace.id]
        );
      }

      // Save outbound email to email_replies for thread tracking
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@localhost';
      await s.exec(
        "INSERT INTO email_replies (id, workspace_id, contact_id, pipeline_job_id, direction, from_email, to_email, subject, body_text, resend_email_id, received_at) VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
        [uuidv4(), req.workspace.id, job.contact_id, job.id, fromEmail, emailTo, job.email_subject, job.email_body, sendResult.messageId]
      );

      res.json({ success: true, messageId: sendResult.messageId });
    } else {
      await s.exec(
        "UPDATE pipeline_jobs SET stage='review', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?",
        [sendResult.error, job.id, req.workspace.id]
      );
      res.json({ success: false, error: sendResult.error });
    }
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

    const emailContent = generateOutreachEmail(
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

    // 3. GA4 UV data
    let gaData = [];
    try {
      const gaMetrics = await ga4.getWebsiteMetrics();
      gaData = (gaMetrics.data || []).map(d => ({ date: d.date, uv: d.activeUsers || 0, sessions: d.sessions || 0 }));
    } catch {}

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
app.post(`${BASE_PATH}/api/discovery/start`, discoveryLimiter, async (req, res) => {
  try {
    const { campaign_id, keywords, platforms, min_subscribers, max_results } = req.body;
    const searchKeywords = keywords || 'gaming AI roleplay, AI character game, AI NPC gaming, AI companion roleplay';

    const jobId = uuidv4();
    await exec("INSERT INTO discovery_jobs (id, campaign_id, search_criteria, status) VALUES (?, ?, ?, 'running')",
      [jobId, campaign_id || 'hakko-q1-all', JSON.stringify({ keywords: searchKeywords, platforms: platforms || ['youtube'], min_subscribers: min_subscribers || 1000, max_results: max_results || 50 })]);

    // Run discovery async
    (async () => {
      try {
        const result = await discoveryAgent.searchYouTubeChannels({
          keywords: searchKeywords,
          maxResults: max_results || 50,
          minSubscribers: min_subscribers || 1000,
        });

        if (!result.success) {
          await exec("UPDATE discovery_jobs SET status='error', completed_at=CURRENT_TIMESTAMP WHERE id=?", [jobId]);
          return;
        }

        // Insert results
        await transaction(async (tx) => {
          for (const ch of result.channels) {
            await tx.exec("INSERT INTO discovery_results (id, job_id, platform, channel_url, channel_name, subscribers, relevance_score, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'found')",
              [uuidv4(), jobId, ch.platform, ch.channel_url, ch.channel_name, ch.subscribers, ch.relevance_score]);
          }
        });

        await exec("UPDATE discovery_jobs SET status='complete', total_found=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
          [result.channels.length, jobId]);
      } catch (e) {
        await exec("UPDATE discovery_jobs SET status='error', completed_at=CURRENT_TIMESTAMP WHERE id=?", [jobId]);
        console.error('Discovery error:', e.message);
      }
    })();

    res.json({ id: jobId, status: 'running', keywords: searchKeywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List discovery jobs
app.get(`${BASE_PATH}/api/discovery/jobs`, async (req, res) => {
  try {
    const result = await query("SELECT * FROM discovery_jobs ORDER BY created_at DESC");
    const jobs = result.rows;
    jobs.forEach(j => { j.search_criteria = JSON.parse(j.search_criteria || '{}'); });
    res.json(jobs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get discovery job with results
app.get(`${BASE_PATH}/api/discovery/jobs/:id`, async (req, res) => {
  try {
    const job = await queryOne("SELECT * FROM discovery_jobs WHERE id=?", [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.search_criteria = JSON.parse(job.search_criteria || '{}');

    const resultsResult = await query("SELECT * FROM discovery_results WHERE job_id=? ORDER BY relevance_score DESC, subscribers DESC", [job.id]);
    res.json({ ...job, results: resultsResult.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Process discovery results through pipeline
app.post(`${BASE_PATH}/api/discovery/jobs/:id/process`, async (req, res) => {
  try {
    const job = await queryOne("SELECT * FROM discovery_jobs WHERE id=?", [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { min_relevance = 30, max_process = 10 } = req.body;

    const resultsResult = await query("SELECT * FROM discovery_results WHERE job_id=? AND status='found' AND relevance_score >= ? ORDER BY relevance_score DESC LIMIT ?",
      [job.id, min_relevance, max_process]);
    const results = resultsResult.rows;

    const processed = [];
    for (const r of results) {
      // Create pipeline job for each
      const pipelineId = uuidv4();
      const username = r.channel_url.split('/').pop();

      await exec("INSERT INTO pipeline_jobs (id, profile_url, platform, username, campaign_id, stage, source) VALUES (?, ?, ?, ?, ?, 'scrape', 'discovery')",
        [pipelineId, r.channel_url, r.platform, username, job.campaign_id || 'hakko-q1-all']);

      await exec("UPDATE discovery_results SET pipeline_job_id=?, status='queued' WHERE id=?",
        [pipelineId, r.id]);

      // Run pipeline async with delay between each to respect API limits
      runPipeline(pipelineId, r.channel_url, r.platform, username, job.campaign_id || 'hakko-q1-all').catch(e => {
        console.error(`Pipeline error for ${r.channel_name}:`, e.message);
      });

      processed.push({ channel: r.channel_name, pipelineId });

      // Delay between pipeline runs
      await new Promise(r => setTimeout(r, 1000));
    }

    await exec("UPDATE discovery_jobs SET total_processed=total_processed+? WHERE id=?",
      [processed.length, job.id]);

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
                  const result = await scraper.scrapeTikTok(profileUrl, ttUsername);
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
async function initializeDefaultData() {
  // Create default admin account from env vars (skip if not configured)
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || 'Admin';
  if (adminEmail && adminPassword) {
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!existing) {
      await registerUser(adminEmail, adminPassword, adminName);
      console.log(`Default admin account created: ${adminEmail}`);
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
    const migrationResult = await runPendingMigrations({ query, exec });
    if (migrationResult.applied > 0) {
      console.log(`[migrations] Applied ${migrationResult.applied} migration(s), total ${migrationResult.total}`);
    }
    await initializeDefaultData();
    app.listen(PORT, () => {
      console.log(`InfluenceX server running on port ${PORT} (${usePostgres ? 'PostgreSQL' : 'SQLite'})`);
      console.log(`Access at: http://localhost:${PORT}${BASE_PATH}/`);
      const sinks = notifications.getEnabledSinks();
      if (sinks.length) console.log(`[notifications] Active sinks: ${sinks.join(', ')}`);
      scheduler.start({ query, exec, queryOne, mailAgent, notifications, uuidv4 });
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

function generateOutreachEmail(kol, campaign, cooperationType, priceQuote) {
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
    const result = await scraper.scrapeProfile(profileUrl, platform, username);

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
    const emailContent = generateOutreachEmail(
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
