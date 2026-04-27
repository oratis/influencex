// API base path. Defaults to /api for root-hosted deploys (influencexes.com).
// Override via VITE_API_BASE at build time if serving under a sub-path.
const BASE = import.meta.env.VITE_API_BASE || '/api';

function getToken() {
  return localStorage.getItem('influencex_token');
}

function setToken(token) {
  if (token) localStorage.setItem('influencex_token', token);
  else localStorage.removeItem('influencex_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Propagate current workspace context to the backend.
  // WorkspaceContext sets window.__influencex_workspace_id.
  if (typeof window !== 'undefined' && window.__influencex_workspace_id) {
    headers['X-Workspace-Id'] = window.__influencex_workspace_id;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    // Token expired or invalid - clear and redirect
    const data = await res.json().catch(() => ({}));
    if (path !== '/auth/me' && path !== '/auth/login' && path !== '/auth/register') {
      setToken(null);
      window.dispatchEvent(new Event('auth:logout'));
    }
    const err = new Error(data.error || 'Authentication required');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    const err = new Error(data.error || 'Too many requests');
    err.statusCode = 429;
    err.code = 'RATE_LIMITED';
    err.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
    throw err;
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(payload.error || 'Request failed');
    err.statusCode = res.status;
    err.code = payload.code || null;
    throw err;
  }
  return res.json();
}

// Translate a thrown error into the right toast. Callers pass their toast + t
// so i18n works. Returns the resolved message string for callers that want to
// also render it in an inline error card.
export function toastApiError(err, toast, t) {
  if (!err) return '';
  if (err.code === 'RATE_LIMITED') {
    const sec = err.retryAfter;
    const msg = sec
      ? `${t('common.error_rate_limited')} (${sec}s)`
      : t('common.error_rate_limited');
    toast?.warning?.(msg);
    return msg;
  }
  if (err.code === 'UNAUTHORIZED') {
    // Auth flow already redirects to login; skip toast to avoid noise.
    return err.message || '';
  }
  // Suppress "Workspace context required" — the server now auto-creates a
  // workspace on login + auth/me, so this error mostly fires on race
  // conditions where the SPA loaded before /auth/me settled. Toasting it
  // would just add noise during onboarding.
  if (err.message && /Workspace context required/i.test(err.message)) {
    return err.message;
  }
  const msg = err.message || t('common.error');
  toast?.error?.(msg);
  return msg;
}

export const auth = {
  getToken,
  setToken,
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  logout: () => request('/auth/logout', { method: 'POST' }).finally(() => setToken(null)),
  me: () => request('/auth/me'),
};

export const api = {
  // Campaigns
  getCampaigns: () => request('/campaigns'),
  getCampaign: (id) => request(`/campaigns/${id}`),
  createCampaign: (data) => request('/campaigns', { method: 'POST', body: data }),
  updateCampaign: (id, data) => request(`/campaigns/${id}`, { method: 'PUT', body: data }),
  deleteCampaign: (id) => request(`/campaigns/${id}`, { method: 'DELETE' }),

  // KOLs
  getKols: (campaignId, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/campaigns/${campaignId}/kols${q ? '?' + q : ''}`);
  },
  addKol: (campaignId, data) => request(`/campaigns/${campaignId}/kols`, { method: 'POST', body: data }),
  collectKols: (campaignId) => request(`/campaigns/${campaignId}/kols/collect`, { method: 'POST' }),
  updateKol: (id, data) => request(`/kols/${id}`, { method: 'PATCH', body: data }),
  batchUpdateKols: (ids, status) => request('/kols/batch', { method: 'PATCH', body: { ids, status } }),
  unblockKolEmail: (id) => request(`/kols/${id}/unblock-email`, { method: 'POST' }),

  // Contacts
  getContacts: (campaignId, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/campaigns/${campaignId}/contacts${q ? '?' + q : ''}`);
  },
  generateEmail: (data) => request('/contacts/generate', { method: 'POST', body: data }),
  updateContact: (id, data) => request(`/contacts/${id}`, { method: 'PUT', body: data }),
  sendEmail: (id) => request(`/contacts/${id}/send`, { method: 'POST' }),
  recordReply: (id, reply_content) => request(`/contacts/${id}/reply`, { method: 'POST', body: { reply_content } }),
  getContactThread: (id) => request(`/contacts/${id}/thread`),
  updateWorkflow: (id, data) => request(`/contacts/${id}/workflow`, { method: 'PATCH', body: data }),
  batchGenerateEmails: (campaignId, data) => request(`/campaigns/${campaignId}/contacts/batch-generate`, { method: 'POST', body: data }),

  // Data
  getContentData: () => request('/data/content'),
  addContentData: (data) => request('/data/content', { method: 'POST', body: data }),
  getRegistrationData: () => request('/data/registrations'),
  addRegistrationData: (data) => request('/data/registrations', { method: 'POST', body: data }),
  seedDemo: () => request('/data/seed-demo', { method: 'POST' }),

  // KOL Database
  getKolApiStatus: () => request('/kol-database/api-status'),
  getKolDatabase: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/kol-database${q ? '?' + q : ''}`);
  },
  getKolDatabaseEntry: (id) => request(`/kol-database/${id}`),
  addKolByUrl: (data) => request('/kol-database', { method: 'POST', body: data }),
  batchAddKolUrls: (urls) => request('/kol-database/batch', { method: 'POST', body: { urls } }),
  deleteKolDatabaseEntry: (id) => request(`/kol-database/${id}`, { method: 'DELETE' }),
  importCampaignKols: (campaignId) => request(`/kol-database/import-campaign/${campaignId}`, { method: 'POST' }),

  // Pipeline (Task 1)
  startPipeline: (data) => request('/pipeline/start', { method: 'POST', body: data }),
  getPipelineJobs: () => request('/pipeline/jobs'),
  getPipelineJob: (id) => request(`/pipeline/jobs/${id}`),
  getPipelineJobThread: (id) => request(`/pipeline/jobs/${id}/thread`),
  editPipelineEmail: (id, data) => request(`/pipeline/jobs/${id}/edit`, { method: 'POST', body: data }),
  approvePipelineEmail: (id, data) => request(`/pipeline/jobs/${id}/approve`, { method: 'POST', body: data }),
  rejectPipelineEmail: (id) => request(`/pipeline/jobs/${id}/reject`, { method: 'POST' }),
  getSmtpStatus: () => request('/smtp/status'),

  // Content Scraping (Task 2)
  scrapeContentViews: () => request('/data/content/scrape', { method: 'POST' }),
  getDashboardCombined: () => request('/data/dashboard/combined'),
  updateContentStats: (id, data) => request(`/data/content/${id}`, { method: 'PUT', body: data }),
  getContentDailyStats: (id) => request(`/data/content/${id}/daily`),

  // Discovery (Task 3)
  startDiscovery: (data) => request('/discovery/start', { method: 'POST', body: data }),
  getDiscoveryJobs: () => request('/discovery/jobs'),
  getDiscoveryJob: (id) => request(`/discovery/jobs/${id}`),
  processDiscoveryResults: (id, data) => request(`/discovery/jobs/${id}/process`, { method: 'POST', body: data }),
  getDiscoveryPlatforms: () => request('/discovery/platforms'),

  // Stats
  getStats: () => request('/stats'),

  // Email Templates
  listEmailTemplates: () => request('/email-templates'),
  listAllEmailTemplates: () => request('/email-templates/all'),
  createEmailTemplate: (data) => request('/email-templates', { method: 'POST', body: data }),
  updateEmailTemplate: (id, data) => request(`/email-templates/${id}`, { method: 'PUT', body: data }),
  deleteEmailTemplate: (id) => request(`/email-templates/${id}`, { method: 'DELETE' }),
  // A/B variants
  listTemplateVariants: (id) => request(`/email-templates/${id}/variants`),
  createTemplateVariant: (id, data) => request(`/email-templates/${id}/variants`, { method: 'POST', body: data }),
  pickTemplateVariant: (contactId, template_id) => request(`/contacts/${contactId}/pick-variant`, { method: 'POST', body: { template_id } }),
  getTemplateStats: (id) => request(`/email-templates/${id}/stats`),
  promoteTemplateWinner: (id, winner_id) => request(`/email-templates/${id}/promote-winner`, { method: 'POST', body: { winner_id } }),
  setTemplateAutoPromote: (id, enabled) => request(`/email-templates/${id}/auto-promote`, { method: 'PATCH', body: { enabled } }),
  renderEmailTemplate: (id, variables) => request(`/email-templates/${id}/render`, { method: 'POST', body: { variables } }),
  renderContactTemplate: (contactId, data) => request(`/contacts/${contactId}/render-template`, { method: 'POST', body: data }),

  // Outreach email sending
  retryEmail: (id) => request(`/contacts/${id}/retry`, { method: 'POST' }),
  batchSendEmails: (campaignId, contact_ids, template_id) => request(`/campaigns/${campaignId}/contacts/batch-send`, { method: 'POST', body: { contact_ids, template_id: template_id || null } }),
  getEmailQueueStats: () => request('/email-queue/stats'),
  getOutreachTasks: () => request('/outreach/tasks'),
  syncEmailStatus: () => request('/email-queue/sync-status', { method: 'POST' }),

  // Mailbox accounts (Connections — mailbox cards)
  listMailboxes: () => request('/mailboxes'),
  createMailbox: (data) => request('/mailboxes', { method: 'POST', body: data }),
  updateMailbox: (id, data) => request(`/mailboxes/${id}`, { method: 'PATCH', body: data }),
  deleteMailbox: (id) => request(`/mailboxes/${id}`, { method: 'DELETE' }),
  verifyMailbox: (id) => request(`/mailboxes/${id}/verify`, { method: 'POST' }),
  dnsCheckMailbox: (id) => request(`/mailboxes/${id}/dns-check`),
  // Gmail OAuth
  getGmailOAuthStatus: () => request('/mailboxes/oauth/gmail/status'),
  initGmailOAuth: () => request('/mailboxes/oauth/gmail/init', { method: 'POST' }),

  // YouTube quota
  getYoutubeQuota: () => request('/quota/youtube'),

  // Permissions (RBAC)
  getMyPermissions: () => request('/auth/permissions'),
  getRoles: () => request('/auth/roles'),

  // CSV Export URLs (use window.open or fetch with auth header)
  exportCampaignKolsUrl: (campaignId) => `${BASE}/campaigns/${campaignId}/kols/export`,
  exportCampaignContactsUrl: (campaignId) => `${BASE}/campaigns/${campaignId}/contacts/export`,
  exportKolDatabaseUrl: () => `${BASE}/kol-database/export`,
  exportContentDataUrl: () => `${BASE}/data/content/export`,

  // Download CSV with auth (for buttons in UI)
  downloadCsv: async (path, filename) => {
    const token = getToken();
    const res = await fetch(`${BASE}${path}`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // Scheduler
  scheduleContact: (id, scheduled_send_at) => request(`/contacts/${id}/schedule`, { method: 'POST', body: { scheduled_send_at } }),
  cancelScheduledContact: (id) => request(`/contacts/${id}/schedule`, { method: 'DELETE' }),
  triggerSchedulerTick: () => request('/scheduler/tick', { method: 'POST' }),

  // ROI Dashboard
  getCampaignRoi: (id) => request(`/campaigns/${id}/roi`),

  // User management (admin only)
  listUsers: () => request('/users'),
  inviteUser: (data) => request('/users/invite', { method: 'POST', body: data }),
  updateUserRole: (id, role) => request(`/users/${id}/role`, { method: 'PATCH', body: { role } }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // Workspaces
  listWorkspaces: () => request('/auth/workspaces'),
  createWorkspace: (data) => request('/workspaces', { method: 'POST', body: data }),
  updateWorkspace: (id, data) => request(`/workspaces/${id}`, { method: 'PATCH', body: data }),
  updateWorkspaceSettings: (id, patch) => request(`/workspaces/${id}/settings`, { method: 'PATCH', body: patch }),
  deleteWorkspace: (id) => request(`/workspaces/${id}`, { method: 'DELETE' }),
  listWorkspaceMembers: (id) => request(`/workspaces/${id}/members`),
  inviteToWorkspace: (id, data) => request(`/workspaces/${id}/members`, { method: 'POST', body: data }),
  updateMemberRole: (wsId, userId, role) => request(`/workspaces/${wsId}/members/${userId}/role`, { method: 'PATCH', body: { role } }),
  removeMember: (wsId, userId) => request(`/workspaces/${wsId}/members/${userId}`, { method: 'DELETE' }),

  // Agents (Phase A Week 2)
  listAgents: () => request('/agents'),
  getAgent: (id) => request(`/agents/${id}`),
  runAgent: (id, input) => request(`/agents/${id}/run`, { method: 'POST', body: input }),
  listAgentRuns: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/agents/runs${q ? '?' + q : ''}`);
  },
  getAgentRun: (id) => request(`/agents/runs/${id}`),
  getAgentCostSummary: () => request('/agents/cost'),
  // SSE stream for a running agent — returns EventSource (caller manages lifecycle)
  streamAgentRun: (runId) => {
    const token = getToken();
    const wsId = window.__influencex_workspace_id;
    const url = `${BASE}/agents/runs/${runId}/stream?token=${encodeURIComponent(token || '')}${wsId ? `&workspace_id=${encodeURIComponent(wsId)}` : ''}`;
    return new EventSource(url);
  },

  // Conductor
  conductorPlan: (goal, opts = {}) => request('/conductor/plan', { method: 'POST', body: { goal }, ...opts }),
  listConductorPlans: () => request('/conductor/plans'),
  getConductorPlan: (id) => request(`/conductor/plans/${id}`),
  conductorRun: (planId) => request(`/conductor/plans/${planId}/run`, { method: 'POST' }),

  // Content pieces (saved agent outputs)
  listContentPieces: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/content/pieces${q ? '?' + q : ''}`);
  },
  createContentPiece: (data) => request('/content/pieces', { method: 'POST', body: data }),
  updateContentPiece: (id, data) => request(`/content/pieces/${id}`, { method: 'PATCH', body: data }),
  deleteContentPiece: (id) => request(`/content/pieces/${id}`, { method: 'DELETE' }),

  // Fetch a remote URL via our server and return as data URL (for
  // persisting expiring image URLs like Volcengine's 24h signed ones)
  fetchAsDataUrl: (url) => request('/util/fetch-as-data-url', { method: 'POST', body: { url } }),

  // Analytics
  getPresetAnalytics: () => request('/analytics/presets'),
  getPlatformAnalytics: () => request('/analytics/platforms'),
  getAgentAnalytics: () => request('/analytics/agents'),
  getContentAnalytics: () => request('/analytics/content'),

  // Prompt presets
  listPromptPresets: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/prompt-presets${q ? '?' + q : ''}`);
  },
  createPromptPreset: (data) => request('/prompt-presets', { method: 'POST', body: data }),
  updatePromptPreset: (id, data) => request(`/prompt-presets/${id}`, { method: 'PATCH', body: data }),
  deletePromptPreset: (id) => request(`/prompt-presets/${id}`, { method: 'DELETE' }),
  usePromptPreset: (id) => request(`/prompt-presets/${id}/use`, { method: 'POST' }),

  // Scheduled publishes
  listScheduledPublishes: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/scheduled-publishes${q ? '?' + q : ''}`);
  },
  schedulePublish: (data) => request('/scheduled-publishes', { method: 'POST', body: data }),
  cancelScheduledPublish: (id) => request(`/scheduled-publishes/${id}`, { method: 'DELETE' }),
  tickScheduledPublishes: () => request('/scheduled-publishes/tick', { method: 'POST' }),

  // Platform OAuth
  listPublishPlatforms: () => request('/publish/platforms'),
  initOAuth: (platform) => request(`/publish/oauth/${platform}/init`, { method: 'POST' }),
  disconnectPlatform: (platform) => request(`/publish/platforms/${platform}`, { method: 'DELETE' }),
  directPublish: (platform, data) => request(`/publish/direct/${platform}`, { method: 'POST', body: data }),

  // Brand voices
  listBrandVoices: () => request('/brand-voices'),
  createBrandVoice: (data) => request('/brand-voices', { method: 'POST', body: data }),
  deleteBrandVoice: (id) => request(`/brand-voices/${id}`, { method: 'DELETE' }),

  // Community inbox
  listInboxMessages: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/inbox-messages${q ? '?' + q : ''}`);
  },
  updateInboxMessage: (id, data) => request(`/inbox-messages/${id}`, { method: 'PATCH', body: data }),

  // Ads strategist — synchronous plan generation.
  createAdsPlan: (data) => request('/ads/plan', { method: 'POST', body: data }),

  // Translate — batched multi-language localization.
  translate: (data) => request('/translate', { method: 'POST', body: data }),

  // Invite codes (admin-managed, public-redeemable)
  listInviteCodes: () => request('/invite-codes'),
  createInviteCode: (data) => request('/invite-codes', { method: 'POST', body: data }),
  revokeInviteCode: (id) => request(`/invite-codes/${id}`, { method: 'DELETE' }),

  // Apify ops (admin only)
  listApifyRuns: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/admin/apify-runs${q ? '?' + q : ''}`);
  },
  reapApifyRuns: () => request('/admin/apify-runs/reap', { method: 'POST' }),
};
