/**
 * Role-Based Access Control.
 *
 * Roles:
 *   - admin  : full access, including user management and destructive ops
 *   - editor : can create/edit campaigns, KOLs, contacts, send emails
 *   - viewer : read-only access to all pages
 *   - member : alias for editor (legacy, kept for backward compatibility)
 *
 * Actions are strings like "campaign.create", "kol.delete", "email.send".
 * When in doubt, prefer the least-privilege requirement.
 *
 * The shape of the model, stated once so route wiring stays consistent:
 *   - viewer  — GET only. Every read route in a workspace, nothing that
 *               writes, sends, spends money, or reveals a credential.
 *               Note: exports are NOT read-only in this model — `data.export`
 *               is editor+, because a CSV of every creator's contact email is
 *               the whole database walking out of the building.
 *   - editor  — everything viewer can do, plus create/edit of campaigns,
 *               KOLs, contacts and content, sending outreach, running agents.
 *               No deletes: destructive operations are admin-only.
 *   - admin   — everything, plus member management, workspace settings,
 *               mailbox + platform credentials, and every delete.
 */

const PERMISSIONS = {
  admin: new Set([
    // User management
    'user.manage', 'user.invite', 'user.delete',
    // Campaigns
    'campaign.create', 'campaign.update', 'campaign.delete', 'campaign.read',
    // KOLs
    'kol.create', 'kol.update', 'kol.delete', 'kol.read',
    // Contacts / Pipeline
    'contact.create', 'contact.update', 'contact.delete', 'contact.read',
    'email.send', 'email.approve',
    // Discovery
    'discovery.start', 'discovery.read',
    // Data
    'data.sync', 'data.export', 'data.read',
    // Content assets: content pieces, prompt presets, brand voices,
    // email templates, scheduled publishes, direct publishing
    'content.create', 'content.update', 'content.delete', 'content.read',
    // Running LLM agents / conductor plans (spends tokens and money)
    'agent.run',
    // Sending identities — API keys, SMTP passwords, OAuth refresh tokens
    'mailbox.manage',
    // Publishing platform connections — same class of secret as mailboxes
    'connection.manage',
    // System
    'system.manage',
  ]),
  editor: new Set([
    'campaign.create', 'campaign.update', 'campaign.read',
    'kol.create', 'kol.update', 'kol.read',
    'contact.create', 'contact.update', 'contact.read',
    'email.send', 'email.approve',
    'discovery.start', 'discovery.read',
    'data.sync', 'data.export', 'data.read',
    'content.create', 'content.update', 'content.read',
    'agent.run',
  ]),
  viewer: new Set([
    'campaign.read',
    'kol.read',
    'contact.read',
    'discovery.read',
    'data.read',
    'content.read',
  ]),
};

// Legacy 'member' role == editor
PERMISSIONS.member = PERMISSIONS.editor;

function hasPermission(role, action) {
  const perms = PERMISSIONS[role] || PERMISSIONS.viewer;
  return perms.has(action);
}

/**
 * Express middleware factory: require a given permission.
 * Must be used AFTER authMiddleware (so req.user is populated).
 *
 * If workspace-middleware ran first, req.workspaceRole contains the role
 * *within that workspace*, which takes precedence over req.user.role.
 * This lets the same user be admin of workspace A and viewer of workspace B.
 */
function requirePermission(action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    // Prefer workspace-scoped role when present, fall back to global user role
    const role = req.workspaceRole || req.user.role || 'viewer';
    if (!hasPermission(role, action)) {
      return res.status(403).json({
        error: `Insufficient permissions: requires "${action}" (your role: ${role})`,
      });
    }
    next();
  };
}

/**
 * Return the list of permissions for a role. Useful for frontend UI gating.
 */
function getRolePermissions(role) {
  const perms = PERMISSIONS[role] || PERMISSIONS.viewer;
  return Array.from(perms);
}

module.exports = {
  hasPermission,
  requirePermission,
  getRolePermissions,
  ROLES: ['admin', 'editor', 'viewer'],
};
