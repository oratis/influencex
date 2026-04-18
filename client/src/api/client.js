const BASE = '/InfluenceX/api';

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
};
