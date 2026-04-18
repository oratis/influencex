/**
 * OpenAPI 3.1 specification for the InfluenceX API.
 *
 * Hand-curated (not auto-generated) to avoid introducing a decorator library.
 * Kept close to the source — when you add a new endpoint, append it here too.
 * Served at /api/openapi.json and rendered by a lightweight Swagger UI page.
 */

function buildOpenApiSpec(basePath = '/InfluenceX') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'InfluenceX API',
      version: '1.0.0',
      description: 'KOL marketing automation platform. Discover creators, run outreach pipelines, track ROI.',
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [
      { url: `${basePath}/api`, description: 'Default server' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        Campaign: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['active', 'paused', 'complete'] },
            budget: { type: 'number' },
            budget_spent: { type: 'number' },
            daily_target: { type: 'integer' },
            platforms: { type: 'array', items: { type: 'string' } },
          },
        },
        Kol: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            campaign_id: { type: 'string' },
            platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'twitch', 'x'] },
            username: { type: 'string' },
            display_name: { type: 'string' },
            followers: { type: 'integer' },
            engagement_rate: { type: 'number' },
            avg_views: { type: 'integer' },
            email: { type: 'string', format: 'email' },
            ai_score: { type: 'number' },
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          },
        },
        Contact: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kol_id: { type: 'string' },
            campaign_id: { type: 'string' },
            email_subject: { type: 'string' },
            email_body: { type: 'string' },
            cooperation_type: { type: 'string', enum: ['affiliate', 'paid'] },
            status: { type: 'string', enum: ['draft', 'sent', 'replied'] },
            contract_status: { type: 'string', enum: ['none', 'sent', 'signed', 'declined'] },
            content_status: { type: 'string' },
            payment_status: { type: 'string', enum: ['unpaid', 'pending', 'paid'] },
            payment_amount: { type: 'number' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'auth', description: 'Authentication and permissions' },
      { name: 'campaigns', description: 'Campaign management' },
      { name: 'kols', description: 'KOL (creator) management' },
      { name: 'contacts', description: 'Contact / outreach management' },
      { name: 'pipeline', description: 'Auto-scrape / write / send pipeline' },
      { name: 'discovery', description: 'KOL discovery by keyword search' },
      { name: 'data', description: 'Content and registration analytics' },
      { name: 'exports', description: 'CSV exports' },
      { name: 'users', description: 'User management (admin only)' },
      { name: 'system', description: 'Health, quota, notifications' },
    ],
    paths: {
      '/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Authenticate and obtain a bearer token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { email: { type: 'string' }, password: { type: 'string' } },
                  required: ['email', 'password'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Login success', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            '400': { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '429': { description: 'Rate limit exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/auth/register': {
        post: {
          tags: ['auth'],
          summary: 'Register a new user account',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } }, required: ['email', 'password', 'name'] } } },
          },
          responses: { '200': { description: 'Registered and logged in' } },
        },
      },
      '/auth/me': {
        get: { tags: ['auth'], summary: 'Get current user', responses: { '200': { description: 'Current user' } } },
      },
      '/auth/permissions': {
        get: { tags: ['auth'], summary: 'Get permissions for current user', responses: { '200': { description: 'Permissions list' } } },
      },
      '/auth/roles': {
        get: { tags: ['auth'], summary: 'List available roles', security: [], responses: { '200': { description: 'Roles' } } },
      },
      '/campaigns': {
        get: { tags: ['campaigns'], summary: 'List campaigns', responses: { '200': { description: 'Campaigns' } } },
        post: { tags: ['campaigns'], summary: 'Create campaign', responses: { '200': { description: 'Created' } } },
      },
      '/campaigns/{id}': {
        get: { tags: ['campaigns'], summary: 'Get campaign', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Campaign' } } },
        put: { tags: ['campaigns'], summary: 'Update campaign', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
        delete: { tags: ['campaigns'], summary: 'Delete campaign', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } },
      },
      '/campaigns/{id}/roi': {
        get: {
          tags: ['campaigns'],
          summary: 'Get aggregated ROI metrics for a campaign',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ROI summary with funnel, content perf, cost metrics' } },
        },
      },
      '/campaigns/{campaignId}/kols': {
        get: { tags: ['kols'], summary: 'List KOLs in campaign', parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'KOLs' } } },
        post: { tags: ['kols'], summary: 'Add KOL to campaign', parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Added' } } },
      },
      '/campaigns/{campaignId}/kols/collect': {
        post: { tags: ['kols'], summary: 'Auto-collect KOLs for campaign (real YouTube API if configured)', parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Collection result with source' } } },
      },
      '/campaigns/{id}/kols/export': {
        get: { tags: ['exports'], summary: 'Export campaign KOLs as CSV', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'CSV file', content: { 'text/csv': {} } } } },
      },
      '/campaigns/{id}/contacts/export': {
        get: { tags: ['exports'], summary: 'Export campaign contacts as CSV', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'CSV file' } } },
      },
      '/kol-database': {
        get: { tags: ['kols'], summary: 'List global KOL database', responses: { '200': { description: 'KOLs' } } },
        post: { tags: ['kols'], summary: 'Add KOL to global database by URL', responses: { '200': { description: 'Added, scraping queued' } } },
      },
      '/kol-database/export': {
        get: { tags: ['exports'], summary: 'Export entire KOL database as CSV', responses: { '200': { description: 'CSV file' } } },
      },
      '/contacts/{id}/send': {
        post: {
          tags: ['contacts'],
          summary: 'Send an outreach email via Resend/SMTP',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Sent (or marked as sent in dry-run)' },
            '400': { description: 'Missing recipient or body' },
            '429': { description: 'Rate limit exceeded' },
            '502': { description: 'Email provider rejected' },
          },
        },
      },
      '/contacts/{id}/schedule': {
        post: { tags: ['contacts'], summary: 'Schedule email for future send', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Scheduled' } } },
        delete: { tags: ['contacts'], summary: 'Cancel scheduled send', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Cancelled' } } },
      },
      '/pipeline/start': {
        post: { tags: ['pipeline'], summary: 'Start auto pipeline for a creator URL', responses: { '200': { description: 'Pipeline job created' } } },
      },
      '/pipeline/jobs': {
        get: { tags: ['pipeline'], summary: 'List pipeline jobs', responses: { '200': { description: 'Jobs' } } },
      },
      '/discovery/start': {
        post: { tags: ['discovery'], summary: 'Start YouTube keyword discovery', responses: { '200': { description: 'Discovery job created' } } },
      },
      '/email-templates': {
        get: { tags: ['contacts'], summary: 'List built-in email templates', responses: { '200': { description: 'Templates' } } },
      },
      '/email-templates/{id}/render': {
        post: { tags: ['contacts'], summary: 'Render a template with variables', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Rendered subject + body' } } },
      },
      '/users': {
        get: { tags: ['users'], summary: 'List all users (admin only)', responses: { '200': { description: 'Users' } } },
      },
      '/users/invite': {
        post: { tags: ['users'], summary: 'Invite a new user (admin only)', responses: { '200': { description: 'Invited' } } },
      },
      '/users/{id}/role': {
        patch: { tags: ['users'], summary: 'Change a user\'s role (admin only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
      },
      '/users/{id}': {
        delete: { tags: ['users'], summary: 'Delete a user (admin only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } },
      },
      '/quota/youtube': {
        get: { tags: ['system'], summary: 'YouTube Data API daily quota usage', responses: { '200': { description: 'Quota status' } } },
      },
      '/notifications/status': {
        get: { tags: ['system'], summary: 'Enabled notification sinks', responses: { '200': { description: 'Sink list' } } },
      },
    },
  };
}

/**
 * Minimal Swagger UI HTML (uses the official CDN-hosted bundle).
 * Self-contained — no build step, no new deps.
 */
function swaggerUiHtml(specUrl) {
  return `<!DOCTYPE html>
<html>
<head>
<title>InfluenceX API Docs</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
<style>
  body { margin: 0; background: #fafafa; }
  .topbar { display: none; }
</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: ${JSON.stringify(specUrl)},
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
  });
</script>
</body>
</html>`;
}

module.exports = { buildOpenApiSpec, swaggerUiHtml };
