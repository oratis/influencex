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
import WorkspaceSettingsPage from './pages/WorkspaceSettingsPage';
import NotFoundPage from './components/NotFoundPage';

// Lazy-load heavy pages
const DataModule = lazy(() => import('./pages/DataModule'));
const RoiDashboard = lazy(() => import('./pages/RoiDashboard'));

function PageFallback() {
  return <div className="page-container"><div className="empty-state"><p>Loading...</p></div></div>;
}

function useNavItems() {
  const { t } = useI18n();
  return [
    { path: '/agents', label: 'Agents', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> },
    { path: '/pipeline', label: t('nav.pipeline'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
    { path: '/campaigns', label: t('nav.campaigns'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> },
    { path: '/roi', label: t('nav.roi'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg> },
    { path: '/contacts', label: t('nav.contacts'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> },
    { path: '/data', label: t('nav.data'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg> },
    { path: '/kol-database', label: t('nav.kol_database'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
    { path: '/users', label: t('nav.users'), icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M20 21v-2a7 7 0 0 0-14 0v2"/></svg> },
  ];
}

function AppContent() {
  const { user, loading, logout } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const { t } = useI18n();
  const navItems = useNavItems();

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

  if (!user) {
    return <AuthPage />;
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
              <Route path="/" element={<Navigate to="/pipeline" replace />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/campaigns" element={<CampaignList />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/roi" element={<Suspense fallback={<PageFallback />}><RoiDashboard /></Suspense>} />
              <Route path="/contacts" element={<ContactModule />} />
              <Route path="/data" element={<Suspense fallback={<PageFallback />}><DataModule /></Suspense>} />
              <Route path="/kol-database" element={<KolDatabase />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/workspace/settings" element={<WorkspaceSettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </CampaignProvider>
  );
}

function GlobalHeader() {
  const { campaigns, selectedCampaignId, selectedCampaign, selectCampaign } = useCampaign();

  return (
    <div className="global-header">
      <div className="global-header-left">
        <span className="global-header-label">Campaign:</span>
        <select
          className="global-campaign-select"
          value={selectedCampaignId}
          onChange={e => selectCampaign(e.target.value)}
        >
          {campaigns.length === 0 && <option value="">No campaigns</option>}
          {campaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {selectedCampaign && (
          <div className="global-header-stats">
            <span className="global-stat">
              <span className={`badge ${selectedCampaign.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{selectedCampaign.status}</span>
            </span>
            <span className="global-stat">{selectedCampaign.kol_total || 0} KOLs</span>
            <span className="global-stat">{selectedCampaign.kol_approved || 0} approved</span>
            {selectedCampaign.budget > 0 && <span className="global-stat">${Number(selectedCampaign.budget).toLocaleString()} budget</span>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <LanguageSwitcher />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <WorkspaceProvider>
            <AppContent />
          </WorkspaceProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
