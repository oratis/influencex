import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../WorkspaceContext';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

export default function WorkspaceSettingsPage() {
  const { t } = useI18n();
  const { currentId, currentWorkspace, refresh, switchWorkspace } = useWorkspace();
  const { user } = useAuth();
  const [tab, setTab] = useState('general');
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirm();

  useEffect(() => {
    setName(currentWorkspace?.name || '');
  }, [currentWorkspace]);

  useEffect(() => {
    if (!currentId) return;
    loadMembers();
  }, [currentId]);

  async function loadMembers() {
    setLoading(true);
    try {
      const res = await api.listWorkspaceMembers(currentId);
      setMembers(res.members || []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  const myRole = members.find(m => m.id === user?.id)?.role || currentWorkspace?.role;
  const canAdmin = myRole === 'admin';

  async function handleSaveName() {
    if (!name.trim() || name === currentWorkspace?.name) return;
    setSaving(true);
    try {
      await api.updateWorkspace(currentId, { name: name.trim() });
      toast.success(t('workspace.renamed'));
      await refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleInvite() {
    const email = await promptDialog(t('workspace.invite_email_prompt'), {
      title: t('workspace.invite_title'),
      placeholder: t('workspace.invite_email_placeholder'),
    });
    if (!email) return;
    const role = await promptDialog(t('workspace.role_prompt'), {
      title: t('workspace.role_title'),
      defaultValue: 'editor',
    });
    if (!['admin', 'editor', 'viewer'].includes(role)) {
      toast.error(t('workspace.role_invalid'));
      return;
    }
    try {
      await api.inviteToWorkspace(currentId, { email: email.trim(), role });
      toast.success(t('workspace.invited', { email, role }));
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleChangeRole(member) {
    const roles = ['admin', 'editor', 'viewer'];
    const idx = roles.indexOf(member.role);
    const next = roles[(idx + 1) % 3];
    const ok = await confirmDialog(t('workspace.change_role_confirm', { email: member.email, from: member.role, to: next }), {
      title: t('workspace.change_role_title'),
      confirmText: t('workspace.change_role_btn'),
    });
    if (!ok) return;
    try {
      await api.updateMemberRole(currentId, member.id, next);
      toast.success(t('workspace.role_updated'));
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleRemove(member) {
    const ok = await confirmDialog(t('workspace.remove_confirm', { email: member.email }), {
      title: t('workspace.remove_title'),
      danger: true,
      confirmText: t('workspace.remove_btn'),
    });
    if (!ok) return;
    try {
      await api.removeMember(currentId, member.id);
      toast.success(t('workspace.removed'));
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDeleteWorkspace() {
    const ok = await confirmDialog(
      t('workspace.delete_confirm', { name: currentWorkspace?.name }),
      { title: t('workspace.delete_title'), danger: true, confirmText: t('workspace.delete_btn') }
    );
    if (!ok) return;
    try {
      await api.deleteWorkspace(currentId);
      toast.success(t('workspace.deleted'));
      await refresh();
      window.location.reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!currentWorkspace) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('workspace.title')}</h2></div>
        <div className="empty-state"><p>{t('workspace.no_workspace')}</p></div>
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('workspace.title')}</h2>
          <p>{t('workspace.subtitle', { name: currentWorkspace.name, role: myRole })}</p>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>{t('workspace.tab_general')}</button>
        <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>{t('workspace.tab_members', { count: members.length })}</button>
        <button className={`tab ${tab === 'danger' ? 'active' : ''}`} onClick={() => setTab('danger')}>{t('workspace.tab_danger')}</button>
      </div>

      {tab === 'general' && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ marginBottom: 16 }}>{t('workspace.name_title')}</h3>
          <div className="form-group">
            <input
              className="form-input"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={!canAdmin}
              placeholder={t('workspace.name_placeholder')}
            />
            {!canAdmin && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{t('workspace.only_admins')}</p>}
          </div>
          <div className="btn-group">
            <button
              className="btn btn-primary"
              onClick={handleSaveName}
              disabled={!canAdmin || saving || name === currentWorkspace.name || !name.trim()}
            >
              {saving ? t('workspace.saving') : t('workspace.save')}
            </button>
          </div>
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <h4 style={{ fontSize: 14, marginBottom: 8 }}>{t('workspace.metadata_title')}</h4>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div><strong>{t('workspace.meta_id')}:</strong> <code style={{ fontSize: 11 }}>{currentWorkspace.id}</code></div>
              <div><strong>{t('workspace.meta_slug')}:</strong> <code style={{ fontSize: 11 }}>{currentWorkspace.slug}</code></div>
              <div><strong>{t('workspace.meta_plan')}:</strong> {currentWorkspace.plan || 'starter'}</div>
              <div><strong>{t('workspace.meta_joined')}:</strong> {currentWorkspace.joined_at ? new Date(currentWorkspace.joined_at).toLocaleDateString() : '—'}</div>
            </div>
          </div>
        </div>
      )}

      {tab === 'members' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div></div>
            {canAdmin && <button className="btn btn-primary" onClick={handleInvite}>{t('workspace.invite_btn')}</button>}
          </div>
          <div className="card">
            {loading ? <div className="empty-state"><p>{t('workspace.loading')}</p></div> :
              members.length === 0 ? <div className="empty-state"><p>{t('workspace.no_members')}</p></div> :
              <div className="table-container">
                <table>
                  <thead><tr>
                    <th>{t('workspace.col_user')}</th>
                    <th>{t('workspace.col_email')}</th>
                    <th>{t('workspace.col_role')}</th>
                    <th>{t('workspace.col_joined')}</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {members.map(m => (
                      <tr key={m.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="kol-avatar"><img src={m.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${m.name}`} alt="" /></div>
                            <div style={{ fontWeight: 600 }}>
                              {m.name}
                              {m.id === user?.id && <span style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 6 }}>{t('workspace.you_tag')}</span>}
                            </div>
                          </div>
                        </td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{m.email}</td>
                        <td><span className={`badge ${m.role === 'admin' ? 'badge-red' : m.role === 'editor' ? 'badge-blue' : 'badge-gray'}`}>{m.role}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.joined_at ? new Date(m.joined_at).toLocaleDateString() : '—'}</td>
                        <td>
                          {canAdmin && m.id !== user?.id && (
                            <div className="btn-group">
                              <button className="btn btn-sm btn-secondary" onClick={() => handleChangeRole(m)}>{t('workspace.btn_role')}</button>
                              <button className="btn btn-sm btn-danger" onClick={() => handleRemove(m)}>{t('workspace.remove_btn')}</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            }
          </div>
        </div>
      )}

      {tab === 'danger' && (
        <div className="card" style={{ maxWidth: 640, borderColor: 'var(--danger)', borderWidth: 1 }}>
          <h3 style={{ color: 'var(--danger)', marginBottom: 12 }}>{t('workspace.danger_title')}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
            {t('workspace.danger_desc')}
            {currentWorkspace.owner_user_id !== user?.id && ' ' + t('workspace.not_owner')}
          </p>
          <button
            className="btn btn-danger"
            onClick={handleDeleteWorkspace}
            disabled={currentWorkspace.owner_user_id !== user?.id}
          >
            {t('workspace.danger_btn')}
          </button>
        </div>
      )}
    </div>
  );
}
