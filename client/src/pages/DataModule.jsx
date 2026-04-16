import React, { useState, useEffect, useCallback } from 'react';
import { AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart, PieChart, Pie, Cell, ReferenceLine } from 'recharts';
import { api } from '../api/client';
import { useCampaign } from '../CampaignContext';

const TRAFFIC_COLORS = ['#6c5ce7', '#00d2a0', '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd'];
const PLATFORM_COLORS = { youtube: '#ff4444', tiktok: '#00f2ea', instagram: '#e1306c', other: '#888' };

export default function DataModule() {
  const { selectedCampaign } = useCampaign();
  const [contentData, setContentData] = useState([]);
  const [regData, setRegData] = useState([]);
  const [tab, setTab] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  // GA4
  const [gaMetrics, setGaMetrics] = useState(null);
  const [gaTraffic, setGaTraffic] = useState(null);
  const [gaRealtime, setGaRealtime] = useState(null);
  // Feishu
  const [feishuStatus, setFeishuStatus] = useState(null);
  const [feishuContent, setFeishuContent] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  // Combined dashboard
  const [dashboardData, setDashboardData] = useState(null);
  // Manual edit modal
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ views: 0, likes: 0, comments: 0, shares: 0 });
  const [saving, setSaving] = useState(false);
  // Daily stats drawer
  const [dailyStatsItem, setDailyStatsItem] = useState(null);
  const [dailyStats, setDailyStats] = useState([]);

  const loadData = async () => {
    // Helper: wrap each API call so failures don't block others
    const safe = (fn, fallback = null) => fn().catch(() => fallback);
    try {
      const [content, reg, gam, gat, gar, fs] = await Promise.all([
        safe(api.getContentData, []),
        safe(api.getRegistrationData, []),
        safe(api.getGA4Metrics),
        safe(api.getGA4Traffic),
        safe(api.getGA4Realtime),
        safe(api.getFeishuStatus),
      ]);
      setContentData(content || []);
      setRegData(reg || []);
      setGaMetrics(gam);
      setGaTraffic(gat);
      setGaRealtime(gar);
      setFeishuStatus(fs);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const loadDashboard = useCallback(async () => {
    try {
      const data = await api.getDashboardCombined();
      setDashboardData(data);
    } catch (e) { console.error('Dashboard load error:', e); }
  }, []);

  useEffect(() => { loadData(); loadDashboard(); }, []);

  // Refresh GA realtime every 30s
  useEffect(() => {
    const timer = setInterval(async () => {
      try { setGaRealtime(await api.getGA4Realtime()); } catch (_) {}
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  const handleFeishuSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.syncFeishu();
      setSyncResult(result);
      // Load full content data
      const allData = await api.getFeishuAllData();
      setFeishuContent(allData);
      await loadData();
      await loadDashboard();
    } catch (e) { setSyncResult({ error: e.message }); }
    setSyncing(false);
  };

  const handleScrapeViews = async () => {
    setScraping(true);
    try {
      const result = await api.scrapeContentViews();
      setSyncResult({ scraped: result.scraped, errors: result.errors });
      await loadData();
      await loadDashboard();
    } catch (e) { setSyncResult({ error: e.message }); }
    setScraping(false);
  };

  const handleEditOpen = (item) => {
    setEditItem(item);
    setEditForm({
      views: item.views || 0,
      likes: item.likes || 0,
      comments: item.comments || 0,
      shares: item.shares || 0,
    });
  };

  const handleEditSave = async () => {
    if (!editItem) return;
    setSaving(true);
    try {
      await api.updateContentStats(editItem.id, editForm);
      setEditItem(null);
      await loadData();
      await loadDashboard();
    } catch (e) { console.error('Save error:', e); }
    setSaving(false);
  };

  const handleShowDailyStats = async (item) => {
    setDailyStatsItem(item);
    setDailyStats([]);
    try {
      const data = await api.getContentDailyStats(item.id);
      setDailyStats(data.daily || []);
    } catch (e) { console.error('Daily stats error:', e); }
  };

  const totalViews = contentData.reduce((s, c) => s + (c.views || 0), 0);
  const totalLikes = contentData.reduce((s, c) => s + (c.likes || 0), 0);
  const totalRegs = regData.reduce((s, c) => s + (c.registrations || 0), 0);
  const gaUV = gaMetrics?.totals?.activeUsers || 0;

  const campaignName = selectedCampaign?.name || 'HakkoAI';

  const customTooltipStyle = {
    backgroundColor: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '13px',
    color: 'var(--text-primary)',
  };

  // Find content publish dates for reference lines
  const publishDates = dashboardData?.combined?.filter(d => d.has_publish).map(d => d.date) || [];

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>{campaignName} - Data Analytics</h2>
          <p>Content performance, website analytics, and registration metrics</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={handleFeishuSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Feishu'}
          </button>
          <button className="btn btn-secondary" onClick={handleScrapeViews} disabled={scraping}>
            {scraping ? 'Scraping...' : 'Scrape Views'}
          </button>
          <button className="btn btn-primary" onClick={() => { loadData(); loadDashboard(); }}>Refresh</button>
        </div>
      </div>

      {/* Top Stats */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon purple" style={{ fontSize: '20px' }}>V</div>
          <div><div className="stat-value">{formatNumber(totalViews)}</div><div className="stat-label">Total Views</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red" style={{ fontSize: '20px' }}>L</div>
          <div><div className="stat-value">{formatNumber(totalLikes)}</div><div className="stat-label">Total Likes</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue" style={{ fontSize: '20px' }}>C</div>
          <div><div className="stat-value">{contentData.length}</div><div className="stat-label">Published Content</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green" style={{ fontSize: '20px' }}>U</div>
          <div><div className="stat-value">{formatNumber(gaUV)}</div><div className="stat-label">Website UV</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ fontSize: '20px', background: 'linear-gradient(135deg, #00d2a0, #00b894)' }}>R</div>
          <div><div className="stat-value">{gaRealtime?.activeUsers || 0}</div><div className="stat-label">Online Now</div></div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {[
          { key: 'dashboard', label: 'Combined Dashboard' },
          { key: 'content', label: 'Published Content' },
          { key: 'analytics', label: 'Website Analytics' },
        ].map(t => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading data...</p></div>
      ) : (
        <>
          {/* ==================== Combined Dashboard (Task 2) ==================== */}
          {tab === 'dashboard' && (
            <div>
              {!dashboardData?.combined?.length ? (
                <div className="empty-state">
                  <h4>No dashboard data yet</h4>
                  <p>Click "Sync Feishu" to pull published content, then "Scrape Views" to get view counts</p>
                  <button className="btn btn-primary" onClick={handleFeishuSync} disabled={syncing}>
                    {syncing ? 'Syncing...' : 'Sync Feishu Now'}
                  </button>
                </div>
              ) : (
                <>
                  {/* Main Combined Chart */}
                  <div className="card" style={{ marginBottom: '20px' }}>
                    <div className="card-header">
                      <h3>Content Views + Website UV + Registrations</h3>
                      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                        Vertical dashed lines = content publish dates
                      </p>
                    </div>
                    <div className="chart-container" style={{ height: '420px' }}>
                      <ResponsiveContainer>
                        <ComposedChart data={dashboardData.combined}>
                          <defs>
                            <linearGradient id="viewsGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6c5ce7" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#6c5ce7" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} />
                          <YAxis yAxisId="views" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={formatNumber} />
                          <YAxis yAxisId="uv" orientation="right" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                          <Tooltip
                            contentStyle={customTooltipStyle}
                            formatter={(val, name) => [formatNumber(val), name]}
                            labelFormatter={l => {
                              const d = dashboardData.combined.find(x => x.date === l);
                              return d?.has_publish ? `${l} (Content Published: ${d.content_count})` : l;
                            }}
                          />
                          <Legend />

                          {/* Content publish date markers */}
                          {publishDates.map(date => (
                            <ReferenceLine
                              key={date}
                              x={date}
                              yAxisId="views"
                              stroke="#feca57"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                            />
                          ))}

                          <Area yAxisId="views" type="monotone" dataKey="views" stroke="#6c5ce7" fill="url(#viewsGrad)" strokeWidth={2} name="Content Views" />
                          <Line yAxisId="uv" type="monotone" dataKey="uv" stroke="#48dbfb" strokeWidth={2} dot={false} name="Website UV" />
                          <Bar yAxisId="uv" dataKey="registrations" fill="rgba(0,210,160,0.6)" name="Registrations" radius={[3, 3, 0, 0]} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                    {/* Content by Date bar chart */}
                    <div className="card">
                      <h3 style={{ marginBottom: '16px', fontSize: '15px' }}>Content Published per Date</h3>
                      <div className="chart-container" style={{ height: '280px' }}>
                        <ResponsiveContainer>
                          <BarChart data={dashboardData.combined.filter(d => d.content_count > 0)}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} />
                            <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} allowDecimals={false} />
                            <Tooltip contentStyle={customTooltipStyle} />
                            <Bar dataKey="content_count" fill="#6c5ce7" radius={[4, 4, 0, 0]} name="Content Count" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Platform distribution */}
                    <div className="card">
                      <h3 style={{ marginBottom: '16px', fontSize: '15px' }}>Platform Distribution</h3>
                      <div className="chart-container" style={{ height: '200px' }}>
                        <ResponsiveContainer>
                          <PieChart>
                            <Pie
                              data={(() => {
                                const counts = {};
                                contentData.forEach(c => { counts[c.platform] = (counts[c.platform] || 0) + 1; });
                                return Object.entries(counts).map(([name, value]) => ({ name, value }));
                              })()}
                              dataKey="value"
                              nameKey="name"
                              cx="50%" cy="50%"
                              outerRadius={80} innerRadius={40}
                            >
                              {Object.keys(PLATFORM_COLORS).map((p, i) => (
                                <Cell key={i} fill={PLATFORM_COLORS[p] || '#888'} />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={customTooltipStyle} />
                            <Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ marginTop: '8px' }}>
                        {contentData.length > 0 && (() => {
                          const counts = {};
                          contentData.forEach(c => { counts[c.platform] = (counts[c.platform] || 0) + 1; });
                          return Object.entries(counts).map(([platform, count]) => (
                            <div key={platform} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid var(--border)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ width: 10, height: 10, borderRadius: '50%', background: PLATFORM_COLORS[platform] || '#888' }} />
                                <span style={{ textTransform: 'capitalize' }}>{platform}</span>
                              </div>
                              <span style={{ fontWeight: '600' }}>{count}</span>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Dashboard Totals */}
                  <div className="card" style={{ marginTop: '20px' }}>
                    <h3 style={{ fontSize: '15px', marginBottom: '14px' }}>Summary</h3>
                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                      <div style={{ textAlign: 'center', padding: '12px' }}>
                        <div style={{ fontSize: '28px', fontWeight: '700', color: '#6c5ce7' }}>{formatNumber(dashboardData.totals?.total_views || 0)}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Total Content Views</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px' }}>
                        <div style={{ fontSize: '28px', fontWeight: '700', color: '#48dbfb' }}>{formatNumber(gaUV)}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Website UV (30d)</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px' }}>
                        <div style={{ fontSize: '28px', fontWeight: '700', color: '#00d2a0' }}>{formatNumber(dashboardData.totals?.total_registrations || 0)}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Total Registrations</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px' }}>
                        <div style={{ fontSize: '28px', fontWeight: '700', color: '#feca57' }}>{dashboardData.totals?.total_content || 0}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Published Content</div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ==================== Published Content Table ==================== */}
          {tab === 'content' && (
            <div className="card">
              <div className="card-header">
                <h3>Published Content (from Feishu)</h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className="badge badge-purple">{contentData.length} items</span>
                  <button className="btn btn-secondary btn-sm" onClick={handleScrapeViews} disabled={scraping} style={{ fontSize: '12px', padding: '4px 10px' }}>
                    {scraping ? 'Scraping...' : 'Scrape Views'}
                  </button>
                </div>
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Content URL</th>
                      <th>Publish Date</th>
                      <th>Views</th>
                      <th>Likes</th>
                      <th>Comments</th>
                      <th>Shares</th>
                      <th style={{ width: '130px' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contentData.map(c => (
                      <tr key={c.id}>
                        <td>
                          <span className="badge" style={{ background: PLATFORM_COLORS[c.platform] || '#888', color: '#fff', fontSize: '11px' }}>
                            {c.platform}
                          </span>
                        </td>
                        <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.content_url ? (
                            <a href={c.content_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: '12px' }}>
                              {c.content_url.replace(/https?:\/\/(www\.)?/, '').slice(0, 50)}
                            </a>
                          ) : '-'}
                        </td>
                        <td style={{ fontSize: '13px' }}>{c.publish_date}</td>
                        <td style={{ fontWeight: '600', color: c.views > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{c.views > 0 ? formatNumber(c.views) : '-'}</td>
                        <td>{c.likes > 0 ? formatNumber(c.likes) : '-'}</td>
                        <td>{c.comments > 0 ? formatNumber(c.comments) : '-'}</td>
                        <td>{c.shares > 0 ? formatNumber(c.shares) : '-'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="btn btn-secondary btn-sm" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => handleEditOpen(c)} title="Edit stats manually">
                              Edit
                            </button>
                            <button className="btn btn-secondary btn-sm" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => handleShowDailyStats(c)} title="View daily stats trend">
                              Trend
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ==================== Website Analytics (GA4) ==================== */}
          {tab === 'analytics' && gaMetrics && (
            <div>
              {!gaMetrics.configured && (
                <div className="card" style={{ marginBottom: '16px', padding: '12px 16px', borderLeft: '3px solid var(--info)' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    GA4 Data API not yet connected. Configure GA4_PROPERTY_ID and service account to see live analytics.
                    Measurement ID: <strong>G-4H57DW4Y3G</strong>
                  </span>
                </div>
              )}

              {/* GA Summary Cards */}
              <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '20px' }}>
                <div className="stat-card">
                  <div><div className="stat-value">{formatNumber(gaMetrics.totals?.sessions || 0)}</div><div className="stat-label">Sessions (30d)</div></div>
                </div>
                <div className="stat-card">
                  <div><div className="stat-value">{formatNumber(gaMetrics.totals?.pageViews || 0)}</div><div className="stat-label">Page Views</div></div>
                </div>
                <div className="stat-card">
                  <div><div className="stat-value">{Math.round(gaMetrics.totals?.avgSessionDuration || 0)}s</div><div className="stat-label">Avg Duration</div></div>
                </div>
                <div className="stat-card">
                  <div><div className="stat-value">{(gaMetrics.totals?.bounceRate || 0).toFixed(1)}%</div><div className="stat-label">Bounce Rate</div></div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
                {/* UV Trend */}
                <div className="card">
                  <h3 style={{ marginBottom: '16px', fontSize: '15px' }}>Daily Active Users (UV)</h3>
                  <div className="chart-container" style={{ height: '350px' }}>
                    <ResponsiveContainer>
                      <AreaChart data={gaMetrics.data || []}>
                        <defs>
                          <linearGradient id="uvGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#48dbfb" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#48dbfb" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                        <Tooltip contentStyle={customTooltipStyle} />
                        <Area type="monotone" dataKey="activeUsers" stroke="#48dbfb" fill="url(#uvGrad)" strokeWidth={2} name="Active Users" />
                        <Area type="monotone" dataKey="newUsers" stroke="#00d2a0" fill="none" strokeWidth={1.5} strokeDasharray="4 4" name="New Users" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Traffic Sources */}
                <div className="card">
                  <h3 style={{ marginBottom: '16px', fontSize: '15px' }}>Traffic Sources</h3>
                  {gaTraffic?.data && gaTraffic.data.length > 0 ? (
                    <>
                      <div className="chart-container" style={{ height: '200px' }}>
                        <ResponsiveContainer>
                          <PieChart>
                            <Pie
                              data={gaTraffic.data.slice(0, 6)}
                              dataKey="activeUsers"
                              nameKey="source"
                              cx="50%" cy="50%"
                              outerRadius={80} innerRadius={40}
                            >
                              {gaTraffic.data.slice(0, 6).map((_, i) => (
                                <Cell key={i} fill={TRAFFIC_COLORS[i % TRAFFIC_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={customTooltipStyle} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ marginTop: '12px' }}>
                        {gaTraffic.data.slice(0, 6).map((t, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: '12px', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ width: 10, height: 10, borderRadius: '50%', background: TRAFFIC_COLORS[i % TRAFFIC_COLORS.length] }} />
                              <span style={{ color: 'var(--text-secondary)', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.source}</span>
                            </div>
                            <span style={{ fontWeight: '600' }}>{formatNumber(t.activeUsers)}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No traffic data available</p>
                  )}
                </div>
              </div>

              {/* Sessions & Page Views chart */}
              <div className="card" style={{ marginTop: '20px' }}>
                <h3 style={{ marginBottom: '16px', fontSize: '15px' }}>Sessions & Page Views</h3>
                <div className="chart-container" style={{ height: '300px' }}>
                  <ResponsiveContainer>
                    <ComposedChart data={gaMetrics.data || []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <Tooltip contentStyle={customTooltipStyle} />
                      <Legend />
                      <Bar yAxisId="left" dataKey="sessions" fill="rgba(108,92,231,0.5)" name="Sessions" radius={[4, 4, 0, 0]} />
                      <Line yAxisId="right" type="monotone" dataKey="pageViews" stroke="#feca57" strokeWidth={2} dot={false} name="Page Views" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ==================== Data Sources Panel ==================== */}
      <div className="card" style={{ marginTop: '20px' }}>
        <h3 style={{ fontSize: '15px', marginBottom: '14px' }}>Data Sources</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
          {/* Feishu Content */}
          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Feishu Spreadsheet</span>
              <span className={`badge ${feishuStatus?.configured ? 'badge-green' : 'badge-orange'}`}>
                {feishuStatus?.configured ? 'Connected' : 'Pending Setup'}
              </span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {feishuStatus?.sheet || 'Published content records with dates and URLs'}
            </p>
          </div>

          {/* YouTube/TikTok Scraper */}
          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Content Scraper</span>
              <span className="badge badge-green">Active</span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              YouTube Data API + TikTok scraping for view counts
            </p>
          </div>

          {/* GA4 */}
          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Google Analytics</span>
              <span className={`badge ${gaMetrics?.configured ? 'badge-green' : 'badge-orange'}`}>
                {gaMetrics?.configured ? 'Connected' : 'Pending Setup'}
              </span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              G-4H57DW4Y3G | Website UV + traffic data
            </p>
          </div>
        </div>

        {syncResult && (
          <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '6px', background: syncResult.error ? 'rgba(255,100,100,0.1)' : 'rgba(0,210,160,0.1)', fontSize: '13px' }}>
            {syncResult.error ? (
              <span style={{ color: '#ff6b6b' }}>Error: {syncResult.error}</span>
            ) : syncResult.scraped !== undefined ? (
              <span style={{ color: '#00d2a0' }}>
                Scraped {syncResult.scraped} content URLs ({syncResult.errors} failed)
              </span>
            ) : (
              <span style={{ color: '#00d2a0' }}>
                Synced {syncResult.total || 0} published content records from Feishu
                {syncResult.syncedAt && ` at ${new Date(syncResult.syncedAt).toLocaleTimeString()}`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ==================== Edit Stats Modal ==================== */}
      {editItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setEditItem(null)}>
          <div className="card" style={{ width: '420px', maxWidth: '90vw', padding: '24px' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: '4px' }}>Edit Content Stats</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px', wordBreak: 'break-all' }}>
              {editItem.content_url?.replace(/https?:\/\/(www\.)?/, '').slice(0, 60)}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              {['views', 'likes', 'comments', 'shares'].map(field => (
                <div key={field}>
                  <label style={{ fontSize: '12px', fontWeight: '600', textTransform: 'capitalize', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>{field}</label>
                  <input
                    type="number"
                    value={editForm[field]}
                    onChange={e => setEditForm(f => ({ ...f, [field]: parseInt(e.target.value) || 0 }))}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '14px' }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
              <button className="btn btn-secondary" onClick={() => setEditItem(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleEditSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Daily Stats Drawer ==================== */}
      {dailyStatsItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDailyStatsItem(null)}>
          <div className="card" style={{ width: '700px', maxWidth: '95vw', padding: '24px' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ marginBottom: '4px' }}>Daily View Trend</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, wordBreak: 'break-all' }}>
                  <span className="badge" style={{ background: PLATFORM_COLORS[dailyStatsItem.platform] || '#888', color: '#fff', fontSize: '10px', marginRight: '6px' }}>
                    {dailyStatsItem.platform}
                  </span>
                  {dailyStatsItem.content_url?.replace(/https?:\/\/(www\.)?/, '').slice(0, 60)}
                </p>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Published: {dailyStatsItem.publish_date || 'Unknown'}
                </p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setDailyStatsItem(null)} style={{ fontSize: '14px', lineHeight: 1, padding: '4px 8px' }}>X</button>
            </div>
            {dailyStats.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                <p>No daily snapshot data yet.</p>
                <p style={{ fontSize: '12px' }}>Click "Scrape Views" to start collecting daily data, or manually edit stats to create a snapshot.</p>
              </div>
            ) : (
              <>
                <div className="chart-container" style={{ height: '300px' }}>
                  <ResponsiveContainer>
                    <ComposedChart data={dailyStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="stat_date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} />
                      <YAxis yAxisId="views" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={formatNumber} />
                      <YAxis yAxisId="engagement" orientation="right" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <Tooltip contentStyle={customTooltipStyle} formatter={(val, name) => [formatNumber(val), name]} />
                      <Legend />
                      <Area yAxisId="views" type="monotone" dataKey="views" stroke="#6c5ce7" fill="rgba(108,92,231,0.15)" strokeWidth={2} name="Views" />
                      <Line yAxisId="engagement" type="monotone" dataKey="likes" stroke="#ff6b6b" strokeWidth={1.5} dot={{ r: 2 }} name="Likes" />
                      <Line yAxisId="engagement" type="monotone" dataKey="comments" stroke="#48dbfb" strokeWidth={1.5} dot={{ r: 2 }} name="Comments" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ marginTop: '12px', maxHeight: '180px', overflowY: 'auto' }}>
                  <table style={{ fontSize: '12px' }}>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Views</th>
                        <th>Likes</th>
                        <th>Comments</th>
                        <th>Shares</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyStats.map((d, i) => (
                        <tr key={i}>
                          <td>{d.stat_date}</td>
                          <td style={{ fontWeight: '600' }}>{formatNumber(d.views)}</td>
                          <td>{formatNumber(d.likes)}</td>
                          <td>{formatNumber(d.comments)}</td>
                          <td>{formatNumber(d.shares)}</td>
                          <td><span className={`badge ${d.source === 'manual' ? 'badge-orange' : 'badge-green'}`} style={{ fontSize: '10px' }}>{d.source}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
