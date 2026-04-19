import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth } from './api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
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

  const register = async (email, password, name) => {
    const result = await auth.register({ email, password, name });
    auth.setToken(result.token);
    setUser(result.user);
    return result;
  };

  const logout = async () => {
    await auth.logout().catch(() => {});
    auth.setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
