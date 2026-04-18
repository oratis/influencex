/**
 * Workspace context middleware.
 *
 * Sets req.workspace = { id, role } after verifying the authenticated user
 * is a member of the requested workspace.
 *
 * Resolution order:
 *   1. URL path parameter :workspaceId (most explicit, preferred for REST)
 *   2. HTTP header X-Workspace-Id (for SSE/WebSocket streams)
 *   3. Session default — user's first-joined workspace (dashboard fallback)
 *
 * Must be mounted AFTER authMiddleware so req.user is populated.
 *
 * Usage:
 *   app.get('/api/v2/workspaces/:workspaceId/campaigns',
 *     authMiddleware, workspaceContext, rbac.requirePermission('campaign.read'),
 *     async (req, res) => { ... req.workspace.id ... });
 */

const { queryOne, query } = require('./database');

/**
 * Resolve a workspace id from multiple sources.
 * Returns the first non-empty source, in priority order.
 */
function resolveWorkspaceId(req) {
  if (req.params?.workspaceId) return req.params.workspaceId;
  const header = req.headers?.['x-workspace-id'];
  if (header && typeof header === 'string') return header.trim();
  if (req.body?.workspace_id) return req.body.workspace_id;
  // Session default: user's first workspace (set by login flow or explicit switcher)
  if (req.user?.currentWorkspaceId) return req.user.currentWorkspaceId;
  return null;
}

/**
 * Look up membership. Returns { role } or null if not a member.
 */
async function findMembership(workspaceId, userId) {
  if (!workspaceId || !userId) return null;
  const row = await queryOne(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId]
  );
  return row || null;
}

/**
 * Express middleware that resolves + verifies the current workspace.
 *
 * Responses:
 *   400 if no workspace id can be resolved (strict mode)
 *   404 if the user is not a member of the resolved workspace
 *   otherwise sets req.workspace + calls next()
 *
 * @param {Object} opts
 * @param {boolean} [opts.lenient] - If true, falls back to the user's
 *   default workspace when no explicit context is provided. Used for
 *   legacy (v1) routes so existing clients keep working post-multitenancy.
 *   Strict (default) routes return 400 when no context is passed.
 */
function workspaceContext(opts = {}) {
  const lenient = opts.lenient === true;

  return async function workspaceContextMiddleware(req, res, next) {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

      let wsId = resolveWorkspaceId(req);

      if (!wsId && lenient) {
        // Legacy-compat path: resolve user's default workspace
        wsId = await getDefaultWorkspaceId(req.user.id);
      }

      if (!wsId) {
        return res.status(400).json({
          error: 'Workspace context required. Provide :workspaceId in URL, X-Workspace-Id header, or workspace_id in body.',
        });
      }

      const membership = await findMembership(wsId, req.user.id);
      if (!membership) {
        // 404 (not 403) to avoid leaking existence of other workspaces to non-members.
        return res.status(404).json({ error: 'Workspace not found or you are not a member' });
      }

      req.workspace = { id: wsId, role: membership.role };
      req.workspaceRole = membership.role;  // convenience alias for RBAC middleware
      next();
    } catch (e) {
      console.error('[workspace-middleware] error:', e.message);
      res.status(500).json({ error: 'Workspace middleware error: ' + e.message });
    }
  };
}

/**
 * Helper used by login/session code: fetch all workspaces a user is a
 * member of, with their role. Used to populate the switcher + pick a
 * default currentWorkspaceId.
 */
async function listUserWorkspaces(userId) {
  const result = await query(
    `SELECT w.id, w.name, w.slug, w.plan, wm.role, wm.joined_at
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = ? AND w.deleted_at IS NULL
     ORDER BY wm.joined_at ASC`,
    [userId]
  );
  return result.rows || [];
}

/**
 * Convenience: get the user's default workspace id (first-joined).
 * Used to auto-populate req.user.currentWorkspaceId on login.
 */
async function getDefaultWorkspaceId(userId) {
  const row = await queryOne(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = ?
     ORDER BY joined_at ASC LIMIT 1`,
    [userId]
  );
  return row?.workspace_id || null;
}

module.exports = {
  workspaceContext,
  resolveWorkspaceId,
  findMembership,
  listUserWorkspaces,
  getDefaultWorkspaceId,
};
