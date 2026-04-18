/**
 * Workspace context — keeps track of the user's current workspace and
 * propagates it to the API client via request interceptor (through the
 * X-Workspace-Id header).
 *
 * Persists the selected workspace in localStorage so refreshes preserve
 * context without a round-trip.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, auth } from './api/client';

const STORAGE_KEY = 'influencex_current_workspace';
const WorkspaceContext = createContext(null);

export function WorkspaceProvider({ children }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [currentId, setCurrentId] = useState(() => localStorage.getItem(STORAGE_KEY) || null);
  const [loading, setLoading] = useState(true);

  const currentWorkspace = workspaces.find(w => w.id === currentId) || null;

  const refresh = useCallback(async () => {
    if (!auth.getToken()) { setLoading(false); return; }
    try {
      const { workspaces: list = [] } = await api.listWorkspaces();
      setWorkspaces(list);
      // If current is invalid or unset, pick the first workspace
      if (!list.find(w => w.id === currentId)) {
        const first = list[0]?.id || null;
        setCurrentId(first);
        if (first) localStorage.setItem(STORAGE_KEY, first);
        else localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[workspace] failed to load workspaces:', e.message);
    } finally {
      setLoading(false);
    }
  }, [currentId]);

  const switchWorkspace = useCallback((id) => {
    setCurrentId(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
    // Reload so every in-memory query cache is invalidated
    window.location.reload();
  }, []);

  useEffect(() => {
    refresh();
    // Re-sync when auth events fire
    const reload = () => refresh();
    window.addEventListener('auth:login', reload);
    window.addEventListener('auth:logout', () => {
      setWorkspaces([]);
      setCurrentId(null);
      localStorage.removeItem(STORAGE_KEY);
    });
    return () => {
      window.removeEventListener('auth:login', reload);
    };
  }, [refresh]);

  // Globally expose the current workspace id so api/client.js can pick it
  // up for the X-Workspace-Id header. Safer than a circular import.
  useEffect(() => {
    window.__influencex_workspace_id = currentId;
  }, [currentId]);

  return (
    <WorkspaceContext.Provider value={{
      workspaces,
      currentId,
      currentWorkspace,
      loading,
      switchWorkspace,
      refresh,
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
