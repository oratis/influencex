/**
 * RBAC route-wiring regression tests (audit S-6).
 *
 * rbac.js has always had a permission map; the problem was that
 * requirePermission() was applied to exactly four route groups. A `viewer` —
 * documented as read-only — could send outreach email, delete campaigns and
 * rewrite mailbox credentials, because none of those routes consulted the map.
 *
 * rbac.test.js covers the middleware in isolation. What that can't catch is
 * someone adding a new write route and forgetting to gate it, so these tests
 * read server/index.js and assert the wiring:
 *
 *   1. named high-risk routes carry the exact permission they should,
 *   2. a viewer is genuinely denied each of those permissions,
 *   3. every /api route is either gated or on an explicit allowlist of routes
 *      that authenticate some other way (public, webhook signature, OAuth
 *      state, inline workspace-admin check).
 *
 * (3) is the one that fails when a new ungated route lands.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { hasPermission } = require('../rbac');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

/** Parse every `app.<method>(`${BASE_PATH}<route>`, ...)` registration. */
function parseRoutes() {
  const routes = [];
  const re = /^app\.(get|post|put|patch|delete|all)\(`\$\{BASE_PATH\}([^`]*)`,?([^\n]*)$/gm;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    const [, method, route, rest] = m;
    const perm = rest.match(/rbac\.requirePermission\('([^']+)'\)/);
    routes.push({
      method: method.toUpperCase(),
      route,
      permission: perm ? perm[1] : null,
      platformAdmin: /requirePlatformAdmin/.test(rest),
      raw: rest,
    });
  }
  return routes;
}

const ROUTES = parseRoutes();
const key = (method, route) => `${method} ${route}`;
const BY_KEY = new Map(ROUTES.map(r => [key(r.method, r.route), r]));

test('the route table parses (sanity check on the regex)', () => {
  assert.ok(ROUTES.length > 150, `only parsed ${ROUTES.length} routes`);
  assert.ok(BY_KEY.has('GET /api/campaigns'));
});

// ==================== Named high-risk routes ====================

// The routes that mattered in the finding, plus one representative of each
// permission family. If any of these loses its gate, this fails by name.
const EXPECTED = {
  // Outreach email — the headline "viewer can send email" case
  'POST /api/contacts/:id/send': 'email.send',
  'POST /api/contacts/:id/retry': 'email.send',
  'POST /api/campaigns/:campaignId/contacts/batch-send': 'email.send',
  'POST /api/discovery/batch-email': 'email.send',
  'POST /api/pipeline/jobs/:id/approve': 'email.approve',

  // Destructive deletes — admin only
  'DELETE /api/campaigns/:id': 'campaign.delete',
  'DELETE /api/kol-database/:id': 'kol.delete',
  'DELETE /api/content/pieces/:id': 'content.delete',
  'DELETE /api/email-templates/:id': 'content.delete',
  'DELETE /api/brand-voices/:id': 'content.delete',
  'DELETE /api/prompt-presets/:id': 'content.delete',
  'DELETE /api/scheduled-publishes/:id': 'content.delete',

  // Mailbox credentials — admin only
  'POST /api/mailboxes': 'mailbox.manage',
  'PATCH /api/mailboxes/:id': 'mailbox.manage',
  'DELETE /api/mailboxes/:id': 'mailbox.manage',
  'POST /api/mailboxes/:id/verify': 'mailbox.manage',
  'POST /api/mailboxes/oauth/gmail/init': 'mailbox.manage',

  // Publishing platform credentials — admin only
  'POST /api/publish/connect/:platform': 'connection.manage',
  'POST /api/publish/oauth/:provider/init': 'connection.manage',
  'DELETE /api/publish/platforms/:platform': 'connection.manage',

  // Writes
  'POST /api/campaigns': 'campaign.create',
  'PUT /api/campaigns/:id': 'campaign.update',
  'PATCH /api/kols/:id': 'kol.update',
  'POST /api/kol-database': 'kol.create',
  'PUT /api/contacts/:id': 'contact.update',
  'POST /api/pipeline/start': 'kol.create',
  'POST /api/discovery/start': 'discovery.start',
  'POST /api/content/pieces': 'content.create',
  'POST /api/publish/direct/:platform': 'content.create',
  'POST /api/util/fetch-as-data-url': 'content.create',

  // Agent runs cost real money
  'POST /api/agents/:id/run': 'agent.run',
  'POST /api/conductor/plans/:id/run': 'agent.run',
  'POST /api/translate': 'agent.run',
  'POST /api/ads/plan': 'agent.run',
  'POST /api/reviews/harvest': 'agent.run',

  // Bulk data egress
  'GET /api/kol-database/export': 'data.export',
  'GET /api/campaigns/:id/kols/export': 'data.export',
  'GET /api/campaigns/:id/contacts/export': 'data.export',
  'GET /api/discovery/jobs/:id/export': 'data.export',
  'GET /api/data/content/export': 'data.export',

  // Creator Marketplace (roadmap D2). Browsing the shared catalog is a read;
  // copying a listing into one of your campaigns creates a kols row.
  // Contributing INTO the shared catalog is platform-admin — see below.
  'POST /api/marketplace/creators/:id/add-to-campaign': 'kol.create',
  'GET /api/marketplace/creators': 'kol.read',

  // Reads stay open to viewers
  'GET /api/campaigns': 'campaign.read',
  'GET /api/kol-database': 'kol.read',
  'GET /api/pipeline/jobs': 'contact.read',
  'GET /api/stats': 'data.read',
  'GET /api/mailboxes': 'data.read',
  'GET /api/usage': 'data.read',
};

for (const [routeKey, expectedPerm] of Object.entries(EXPECTED)) {
  test(`${routeKey} requires ${expectedPerm}`, () => {
    const r = BY_KEY.get(routeKey);
    assert.ok(r, `route not found in index.js: ${routeKey}`);
    assert.equal(r.permission, expectedPerm);
  });
}

// ==================== Viewer is read-only ====================

test('viewer is denied every write/send/delete permission we gate on', () => {
  const writePerms = new Set(
    Object.values(EXPECTED).filter(p => !p.endsWith('.read'))
  );
  for (const perm of writePerms) {
    assert.equal(hasPermission('viewer', perm), false, `viewer must not have ${perm}`);
  }
});

test('viewer keeps every read permission we gate on', () => {
  for (const perm of ['campaign.read', 'kol.read', 'contact.read', 'data.read', 'content.read', 'discovery.read']) {
    assert.ok(hasPermission('viewer', perm), `viewer should have ${perm}`);
  }
});

test('editor can work but cannot delete or touch credentials', () => {
  for (const perm of ['campaign.create', 'kol.update', 'contact.update', 'email.send', 'email.approve', 'content.create', 'content.update', 'agent.run', 'data.export']) {
    assert.ok(hasPermission('editor', perm), `editor should have ${perm}`);
  }
  for (const perm of ['campaign.delete', 'kol.delete', 'contact.delete', 'content.delete', 'mailbox.manage', 'connection.manage', 'user.manage', 'system.manage']) {
    assert.equal(hasPermission('editor', perm), false, `editor must not have ${perm}`);
  }
});

test('admin has everything the routes ask for', () => {
  for (const perm of new Set(Object.values(EXPECTED))) {
    assert.ok(hasPermission('admin', perm), `admin should have ${perm}`);
  }
});

// ==================== No ungated workspace routes ====================

// Routes that legitimately carry no permission gate, each with the reason.
// Adding to this list is a deliberate act; forgetting to gate a new route is
// not, which is why the default is "fails the test".
const UNGATED_ALLOWLIST = new Set([
  // Not under /api, or spec/doc endpoints
  'GET /metrics', 'GET /api/openapi.json', 'GET /api/docs',
  // Auth + signup: unauthenticated by definition, rate-limited instead
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password', 'POST /api/auth/logout', 'GET /api/auth/me',
  'GET /api/auth/google/init', 'GET /api/auth/google/callback', 'GET /api/auth/google/status',
  'GET /api/auth/workspaces', 'GET /api/auth/permissions', 'GET /api/auth/roles',
  'GET /api/invitations/:token', 'POST /api/invitations/:token/accept',
  'GET /api/invite-codes/lookup/:code', 'POST /api/auth/register-with-code',
  // Workspace management: enforces workspace-admin inline off the :id param,
  // which is more precise than req.workspaceRole here (these routes are
  // outside the workspace-context middleware).
  'POST /api/workspaces', 'PATCH /api/workspaces/:id', 'PATCH /api/workspaces/:id/settings',
  'DELETE /api/workspaces/:id', 'GET /api/workspaces/:id/members',
  'POST /api/workspaces/:id/members', 'PATCH /api/workspaces/:id/members/:userId/role',
  'DELETE /api/workspaces/:id/members/:userId',
  // Inbound webhooks: authenticated by provider signature
  'POST /api/webhooks/resend/inbound', 'POST /api/webhooks/resend/events', 'POST /api/webhooks/apify',
  // OAuth callbacks: authenticated by the state row / in-memory state store
  'GET /api/publish/oauth/:provider/callback', 'GET /api/mailboxes/oauth/gmail/callback',
  // SSE stream: query-string token, resolves workspace from the run row itself
  'GET /api/agents/runs/:runId/stream',
  // SSE stream: same contract, resolved from the conductor_plans row
  'GET /api/conductor/plans/:id/stream',
  // Platform-level ops counters — outside workspace context, so a permission
  // check here would fall back to the global users.role rather than the
  // workspace role and read as a stricter guarantee than it is.
  'GET /api/quota/youtube', 'GET /api/quota/apify',
  'GET /api/queue/stats', 'GET /api/cache/stats', 'GET /api/apify/status',
  // Public release notes
  'GET /api/changelog',
]);

test('every /api route is gated, platform-admin-only, or explicitly allowlisted', () => {
  const ungated = ROUTES
    .filter(r => !r.permission && !r.platformAdmin)
    .map(r => key(r.method, r.route))
    .filter(k => !UNGATED_ALLOWLIST.has(k));
  assert.deepEqual(
    ungated, [],
    'new ungated route(s) — add rbac.requirePermission(...) or, if it authenticates ' +
    'another way, add it to UNGATED_ALLOWLIST with a reason:\n  ' + ungated.join('\n  ')
  );
});

// Platform-level operations must NOT be gated with rbac.requirePermission:
// it prefers req.workspaceRole, and any user can create a workspace where
// they are admin — so a workspace-role check is self-granting here. These
// need the global users.role check instead.
const PLATFORM_ADMIN_ROUTES = [
  'POST /api/data/seed-demo',   // rewrites a fixed-id campaign row
  'GET /api/admin/usage',       // reads token/cost across every tenant
  // Publishes rows into creators_public, the one table every tenant reads.
  // A workspace-role check would be self-granting here (anyone can create a
  // workspace where they are admin), so this needs the global users.role.
  'POST /api/marketplace/contribute',
];

for (const routeKey of PLATFORM_ADMIN_ROUTES) {
  test(`${routeKey} is platform-admin-only (not a workspace-role check)`, () => {
    const r = BY_KEY.get(routeKey);
    assert.ok(r, `route not found in index.js: ${routeKey}`);
    assert.ok(r.platformAdmin, 'must use requirePlatformAdmin');
    assert.ok(!r.permission, 'must not rely on rbac.requirePermission — see comment above');
  });
}

test('the allowlist has no stale entries', () => {
  const stale = [...UNGATED_ALLOWLIST].filter(k => {
    const r = BY_KEY.get(k);
    return !r || r.permission || r.platformAdmin;
  });
  assert.deepEqual(stale, [], 'allowlist entries that are gone or now gated');
});

// ==================== The public invite-code lookup is rate limited ====================

test('GET /api/invite-codes/lookup/:code carries a rate limiter', () => {
  // Public + unauthenticated + confirms whether a code exists. 8 base32 chars
  // is ~40 bits; unlimited, a sweep is a weekend project.
  const r = BY_KEY.get('GET /api/invite-codes/lookup/:code');
  assert.ok(r, 'route not found');
  assert.match(r.raw, /inviteLookupLimiter/, 'lookup route must be rate limited');
});

test('the invite lookup limiter declares a finite budget', () => {
  const decl = SRC.match(/const inviteLookupLimiter = rateLimit\(\{[\s\S]*?\}\);/);
  assert.ok(decl, 'inviteLookupLimiter declaration not found');
  assert.match(decl[0], /max:\s*\d+/);
  // Bucket isolation is no longer this limiter's problem: rate-limit.js
  // namespaces every rateLimit() instance, and rate-limit.test.js proves two
  // default-keyFn limiters can't drain each other. This used to assert a
  // hand-rolled `invite-lookup:` key prefix, which tested the workaround
  // rather than the property.
});
