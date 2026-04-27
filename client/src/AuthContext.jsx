import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth } from './api/client';
import * as sentry from './sentry';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(null);
  const setUser = (u) => {
    setUserState(u);
    sentry.setUser(u || null);
  };
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // SSO return path: /auth/callback sets #sso_token=<token> in the URL
    // fragment. Drain it before calling auth.me.
    if (window.location.hash.includes('sso_token=')) {
      const m = window.location.hash.match(/sso_token=([^&]+)/);
      if (m) {
        auth.setToken(decodeURIComponent(m[1]));
        // Strip the token from the URL so it isn't visible in history.
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }

    // Check for existing session on mount
    const token = auth.getToken();
    if (token) {
      auth.me()
        .then(setUser)
        .catch(() => { auth.setToken(null); })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }

    // Listen for forced logout events
    const handleLogout = () => { setUser(null); };
    window.addEventListener('auth:logout', handleLogout);
    return () => window.removeEventListener('auth:logout', handleLogout);
  }, []);

  const login = async (email, password) => {
    const result = await auth.login({ email, password });
    auth.setToken(result.token);
    setUser(result.user);
    return result;
  };

  // Seed the client session from an already-issued login response (e.g. the
  // body of POST /api/invitations/:token/accept, which auto-logs-in on
  // success). Used so AcceptInvitePage can hand off to the main app without
  // a second round-trip to /auth/login.
  const setSessionFromApi = (result) => {
    if (result?.token) auth.setToken(result.token);
    if (result?.user) setUser(result.user);
  };

  const logout = async () => {
    await auth.logout().catch(() => {});
    auth.setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setSessionFromApi }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
