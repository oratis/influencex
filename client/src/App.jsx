import React, { useState, Suspense, lazy } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { CampaignProvider, useCampaign } from './CampaignContext';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { I18nProvider, useI18n } from './i18n';
import { WorkspaceProvider } from './WorkspaceContext';
import LanguageSwitcher from './components/LanguageSwitcher';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import AuthPage from './pages/AuthPage';
import CampaignList from './pages/CampaignList';
import CampaignDetail from './pages/CampaignDetail';
import ContactModule from './pages/ContactModule';
import KolDatabase from './pages/KolDatabase';
import PipelinePage from './pages/PipelinePage';
import UsersPage from './pages/UsersPage';
import AgentsPage from './pages/AgentsPage';
import ContentStudio from './pages/ContentStudio';
import ConductorPage from './pages/ConductorPage';
import ConnectionsPage from './pages/ConnectionsPage';
import CalendarPage from './pages/CalendarPage';
import AnalyticsPage from './pages/AnalyticsPage';
import CommunityInboxPage from './pages/CommunityInboxPage';
import AdsPage from './pages/AdsPage';
import TranslatePage from './pages/TranslatePage';
import LandingPage from './pages/LandingPage';
import AcceptInvitePage from './pages/AcceptInvitePage';
import SignupWithCodePage from './pages/SignupWithCodePage';
import InviteCodesPage from './pages/InviteCodesPage';
import WorkspaceSettingsPage from './pages/WorkspaceSettingsPage';
import NotFoundPage from './components/NotFoundPage';
import ErrorBoundary from './components/ErrorBoundary';

// Lazy-load heavy pages
const DataModule = lazy(() => import('./pages/DataModule'));
const RoiDashboard = lazy(() => import('./pages/RoiDashboard'));

function PageFallback() {
  const { t } = useI18n();
  return <div className="page-container"><div className="empty-state"><p>{t('common.loading')}</p></div></div>;
}

function useNavItems(user) {
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const items = [
    { path: '/conductor', label: t('nav.conductor'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> },
    { path: '/studio', label: t('nav.studio'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg> },
    { path: '/calendar', label: t('nav.calendar'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
    { path: '/connections', label: t('nav.connections'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> },
    { path: '/analytics', label: t('nav.analytics'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg> },
    { path: '/inbox', label: t('nav.community'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> },
    { path: '/ads', label: t('nav.ads'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 11l18-5v13L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg> },
    { path: '/translate', label: t('nav.translate'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 8h10"/><path d="M9 4v4"/><path d="M7 12c0 4 3 7 7 7"/><path d="M17 20l4-9 4 9"/><path d="M18 17h6"/></svg> },
    { path: '/agents', label: t('nav.agents'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> },
    { path: '/pipeline', label: t('nav.pipeline'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
    { path: '/campaigns', label: t('nav.campaigns'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> },
    { path: '/roi', label: t('nav.roi'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg> },
    { path: '/contacts', label: t('nav.contacts'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> },
    { path: '/data', label: t('nav.data'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg> },
    { path: '/kol-database', label: t('nav.kol_database'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
    { path: '/users', label: t('nav.users'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M20 21v-2a7 7 0 0 0-14 0v2"/></svg> },
  ];
  if (isAdmin) {
    items.push({
      path: '/invite-codes',
      label: t('nav.invite_codes'),
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
    });
  }
  return items;
}

function AppContent() {
  const { user, loading, logout } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const { t } = useI18n();
  const navItems = useNavItems(user);

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-container">
          <div className="auth-header">
            <div className="auth-logo"><span className="auth-logo-icon">🎯</span><h1>InfluenceX</h1></div>
            <p className="auth-subtitle" style={{ marginTop: '24px' }}>{t('common.loading')}</p>
          </div>
        </div>
      </div>
    );
  }

  // /accept-invite and /signup work regardless of auth state. /signup is
  // the public invite-code signup; /accept-invite is the per-email invitation
  // flow. If the user is already logged in with a different email, both flows
  // return EMAIL_EXISTS and nudge them to log in instead.
  if (window.location.hash.startsWith('#/accept-invite')) {
    return (
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="*" element={<AcceptInvitePage />} />
      </Routes>
    );
  }
  if (window.location.hash.startsWith('#/signup')) {
    return (
      <Routes>
        <Route path="/signup" element={<SignupWithCodePage />} />
        <Route path="*" element={<SignupWithCodePage />} />
      </Routes>
    );
  }

  if (!user) {
    // Public routes. /signup uses the invite-code flow (anyone with a valid
    // code can register). /accept-invite renders the per-email invitation
    // flow (creates account + logs in).
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/signup" element={<SignupWithCodePage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="*" element={<AuthPage />} />
      </Routes>
    );
  }

  return (
    <CampaignProvider>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-logo">
              <span>🎯</span>
              <h1>InfluenceX</h1>
            </div>
          </div>
          <WorkspaceSwitcher />
          <nav className="sidebar-nav">
            {navItems.map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                aria-label={item.label}
                title={item.label}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-user">
            <div className="sidebar-user-info" onClick={() => setShowUserMenu(v => !v)}>
              <div className="sidebar-avatar">
                <img src={user.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${user.name}`} alt="" />
              </div>
              <div className="sidebar-user-details">
                <div className="sidebar-user-name">{user.name}</div>
                <div className="sidebar-user-email">{user.email}</div>
              </div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" style={{ flexShrink: 0, opacity: 0.5 }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
            {showUserMenu && (
              <div className="sidebar-user-menu">
                <div className="sidebar-user-menu-item" style={{ opacity: 0.5, cursor: 'default' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <span>{t(`roles.${user.role || 'member'}`)}</span>
                </div>
                <div className="sidebar-user-menu-item" onClick={() => { setShowUserMenu(false); logout(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  <span>{t('auth.sign_out')}</span>
                </div>
              </div>
            )}
          </div>
        </aside>
        <div className="main-wrapper">
          <GlobalHeader />
          <main className="main-content" onClick={() => showUserMenu && setShowUserMenu(false)}>
            <Routes>
              <Route path="/" element={<HomeRedirect />} />
              <Route path="/conductor" element={<ConductorPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/inbox" element={<CommunityInboxPage />} />
              <Route path="/ads" element={<AdsPage />} />
              <Route path="/translate" element={<TranslatePage />} />
              <Route path="/studio" element={<ContentStudio />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/campaigns" element={<CampaignList />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/roi" element={<Suspense fallback={<PageFallback />}><RoiDashboard /></Suspense>} />
              <Route path="/contacts" element={<ContactModule />} />
              <Route path="/data" element={<Suspense fallback={<PageFallback />}><DataModule /></Suspense>} />
              <Route path="/kol-database" element={<KolDatabase />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/invite-codes" element={<InviteCodesPage />} />
              <Route path="/workspace/settings" element={<WorkspaceSettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </CampaignProvider>
  );
}

// Smart landing: first-time users with zero campaigns get sent to Conductor
// (the best place to bootstrap a plan from scratch). Returning users with
// at least one campaign land on Pipeline (their main daily workspace).
function HomeRedirect() {
  const { campaigns, loading } = useCampaign();
  if (loading) return null;
  return <Navigate to={campaigns.length > 0 ? '/pipeline' : '/conductor'} replace />;
}

function GlobalHeader() {
  const { campaigns, selectedCampaignId, selectedCampaign, selectCampaign } = useCampaign();
  const { t } = useI18n();

  return (
    <div className="global-header">
      <div className="global-header-left">
        <span className="global-header-label">{t('nav.campaigns')}:</span>
        <select
          className="global-campaign-select"
          value={selectedCampaignId}
          onChange={e => selectCampaign(e.target.value)}
        >
          {campaigns.length === 0 && <option value="">{t('campaigns.no_campaigns')}</option>}
          {campaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {selectedCampaign && (
          <div className="global-header-stats">
            <span className="global-stat">
              <span className={`badge ${selectedCampaign.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{t(`campaigns.status_${selectedCampaign.status}`) || selectedCampaign.status}</span>
            </span>
            <span className="global-stat">{t('campaigns.kols_total', { count: selectedCampaign.kol_total || 0 })}</span>
            <span className="global-stat">{t('campaigns.kols_approved', { count: selectedCampaign.kol_approved || 0 })}</span>
            {selectedCampaign.budget > 0 && <span className="global-stat">{t('campaigns.budget', { amount: Number(selectedCampaign.budget).toLocaleString() })}</span>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <LanguageSwitcher />
      </div>
    </div>
  );
}

function BoundaryWithI18n({ children }) {
  const { t } = useI18n();
  return <ErrorBoundary t={t}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <WorkspaceProvider>
            <BoundaryWithI18n>
              <AppContent />
            </BoundaryWithI18n>
          </WorkspaceProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
