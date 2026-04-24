import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../WorkspaceContext';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { useI18n } from '../i18n';
import { api } from '../api/client';

/**
 * Top-of-sidebar workspace selector + quick actions.
 * Single-workspace users see it as a read-only label.
 */
export default function WorkspaceSwitcher() {
  const { workspaces, currentId, currentWorkspace, switchWorkspace, refresh } = useWorkspace();
  const [showMenu, setShowMenu] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const { prompt: promptDialog } = useConfirm();
  const { t } = useI18n();

  if (!currentWorkspace) return null;

  async function handleCreate() {
    const name = await promptDialog(t('workspace_switcher.prompt_name'), { title: t('workspace_switcher.prompt_title'), placeholder: t('workspace_switcher.prompt_placeholder') });
    if (!name) return;
    try {
      const ws = await api.createWorkspace({ name });
      toast.success(t('workspace_switcher.created', { name }));
      await refresh();
      switchWorkspace(ws.id);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div style={{ position: 'relative', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={() => workspaces.length > 1 || true ? setShowMenu(v => !v) : null}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          cursor: 'pointer', padding: '8px 12px', borderRadius: '8px',
          background: showMenu ? 'var(--bg-card)' : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: 'linear-gradient(135deg, #6c5ce7, #a29bfe)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontWeight: 700, fontSize: 13,
        }}>
          {(currentWorkspace.name || '?').charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {currentWorkspace.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {t(`roles.${currentWorkspace.role || 'member'}`)}
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ opacity: 0.5, transform: showMenu ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {showMenu && (
        <div style={{
          position: 'absolute', top: '100%', left: 8, right: 8, marginTop: 4,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 4, zIndex: 120,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          animation: 'fadeIn 0.12s ease',
        }}>
          {workspaces.map(w => (
            <div
              key={w.id}
              onClick={() => { setShowMenu(false); if (w.id !== currentId) switchWorkspace(w.id); }}
              style={{
                padding: '10px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
                background: w.id === currentId ? 'var(--accent-light)' : 'transparent',
                color: w.id === currentId ? 'var(--accent)' : 'var(--text-primary)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
              onMouseEnter={e => { if (w.id !== currentId) e.currentTarget.style.background = 'var(--bg-card)'; }}
              onMouseLeave={e => { if (w.id !== currentId) e.currentTarget.style.background = 'transparent'; }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{w.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t(`roles.${w.role || 'member'}`)}</div>
              </div>
              {w.id === currentId && <span style={{ fontSize: 12 }}>✓</span>}
            </div>
          ))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <div
            onClick={() => { setShowMenu(false); handleCreate(); }}
            style={{
              padding: '10px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {t('workspace_switcher.new_workspace')}
          </div>
          <div
            onClick={() => { setShowMenu(false); navigate('/workspace/settings'); }}
            style={{
              padding: '10px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {t('workspace_switcher.settings')}
          </div>
        </div>
      )}
    </div>
  );
}
