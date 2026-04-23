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
    throw new Error(data.error || 'Authentication required');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const auth = {
  getToken,
  setToken,
  register: (data) => request('/auth/register', { method: 'POST', body: data }),
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

  // GA4 Analytics
  getGA4Metrics: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/data/ga4/metrics${q ? '?' + q : ''}`); },
  getGA4Traffic: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/data/ga4/traffic${q ? '?' + q : ''}`); },
  getGA4Realtime: () => request('/data/ga4/realtime'),
  getGA4Status: () => request('/data/ga4/status'),

  // Feishu
  syncFeishu: () => request('/data/feishu/sync', { method: 'POST' }),
  getFeishuStatus: () => request('/data/feishu/status'),
  getFeishuAllData: () => request('/data/feishu/all'),

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

  // Stats
  getStats: () => request('/stats'),

  // Email Templates
  listEmailTemplates: () => request('/email-templates'),
  renderEmailTemplate: (id, variables) => request(`/email-templates/${id}/render`, { method: 'POST', body: { variables } }),
  renderContactTemplate: (contactId, data) => request(`/contacts/${contactId}/render-template`, { method: 'POST', body: data }),

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

  // Notifications
  getNotificationStatus: () => request('/notifications/status'),

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
  conductorPlan: (goal) => request('/conductor/plan', { method: 'POST', body: { goal } }),
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
};
