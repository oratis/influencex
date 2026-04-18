import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../WorkspaceContext';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

export default function WorkspaceSettingsPage() {
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
      toast.success('Workspace renamed');
      await refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleInvite() {
    const email = await promptDialog('Email address to invite:', {
      title: 'Invite to workspace',
      placeholder: 'person@company.com',
    });
    if (!email) return;
    const role = await promptDialog('Role (admin / editor / viewer):', {
      title: 'Role',
      defaultValue: 'editor',
    });
    if (!['admin', 'editor', 'viewer'].includes(role)) {
      toast.error('Role must be admin, editor, or viewer');
      return;
    }
    try {
      await api.inviteToWorkspace(currentId, { email: email.trim(), role });
      toast.success(`Invited ${email} as ${role}`);
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleChangeRole(member) {
    const roles = ['admin', 'editor', 'viewer'];
    const idx = roles.indexOf(member.role);
    const next = roles[(idx + 1) % 3];
    const ok = await confirmDialog(`Change ${member.email} from ${member.role} → ${next}?`, {
      title: 'Change role',
      confirmText: 'Change',
    });
    if (!ok) return;
    try {
      await api.updateMemberRole(currentId, member.id, next);
      toast.success(`Role updated`);
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleRemove(member) {
    const ok = await confirmDialog(`Remove ${member.email} from this workspace?`, {
      title: 'Remove member',
      danger: true,
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      await api.removeMember(currentId, member.id);
      toast.success('Member removed');
      loadMembers();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDeleteWorkspace() {
    const ok = await confirmDialog(
      `Soft-delete "${currentWorkspace?.name}"? Data is retained 30 days before permanent deletion.`,
      { title: 'Delete workspace', danger: true, confirmText: 'Delete' }
    );
    if (!ok) return;
    try {
      await api.deleteWorkspace(currentId);
      toast.success('Workspace deleted');
      await refresh();
      // Switch to remaining workspace (refresh handles picking a new default)
      window.location.reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!currentWorkspace) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>Workspace Settings</h2></div>
        <div className="empty-state"><p>No workspace selected</p></div>
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Workspace Settings</h2>
          <p>Manage {currentWorkspace.name} — your role: <strong>{myRole}</strong></p>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>General</button>
        <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>Members ({members.length})</button>
        <button className={`tab ${tab === 'danger' ? 'active' : ''}`} onClick={() => setTab('danger')}>Danger zone</button>
      </div>

      {tab === 'general' && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ marginBottom: 16 }}>Workspace name</h3>
          <div className="form-group">
            <input
              className="form-input"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={!canAdmin}
              placeholder="Workspace name"
            />
            {!canAdmin && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Only admins can edit</p>}
          </div>
          <div className="btn-group">
            <button
              className="btn btn-primary"
              onClick={handleSaveName}
              disabled={!canAdmin || saving || name === currentWorkspace.name || !name.trim()}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <h4 style={{ fontSize: 14, marginBottom: 8 }}>Metadata</h4>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div><strong>ID:</strong> <code style={{ fontSize: 11 }}>{currentWorkspace.id}</code></div>
              <div><strong>Slug:</strong> <code style={{ fontSize: 11 }}>{currentWorkspace.slug}</code></div>
              <div><strong>Plan:</strong> {currentWorkspace.plan || 'starter'}</div>
              <div><strong>Joined:</strong> {currentWorkspace.joined_at ? new Date(currentWorkspace.joined_at).toLocaleDateString() : '—'}</div>
            </div>
          </div>
        </div>
      )}

      {tab === 'members' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div></div>
            {canAdmin && <button className="btn btn-primary" onClick={handleInvite}>+ Invite</button>}
          </div>
          <div className="card">
            {loading ? <div className="empty-state"><p>Loading...</p></div> :
              members.length === 0 ? <div className="empty-state"><p>No members</p></div> :
              <div className="table-container">
                <table>
                  <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead>
                  <tbody>
                    {members.map(m => (
                      <tr key={m.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="kol-avatar"><img src={m.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${m.name}`} alt="" /></div>
                            <div style={{ fontWeight: 600 }}>
                              {m.name}
                              {m.id === user?.id && <span style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 6 }}>(you)</span>}
                            </div>
                          </div>
                        </td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{m.email}</td>
                        <td><span className={`badge ${m.role === 'admin' ? 'badge-red' : m.role === 'editor' ? 'badge-blue' : 'badge-gray'}`}>{m.role}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.joined_at ? new Date(m.joined_at).toLocaleDateString() : '—'}</td>
                        <td>
                          {canAdmin && m.id !== user?.id && (
                            <div className="btn-group">
                              <button className="btn btn-sm btn-secondary" onClick={() => handleChangeRole(m)}>Role</button>
                              <button className="btn btn-sm btn-danger" onClick={() => handleRemove(m)}>Remove</button>
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
          <h3 style={{ color: 'var(--danger)', marginBottom: 12 }}>Delete workspace</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
            Soft-deletes this workspace. Data is retained for 30 days before permanent deletion. Only the workspace owner can delete.
            {currentWorkspace.owner_user_id !== user?.id && ' You are not the owner.'}
          </p>
          <button
            className="btn btn-danger"
            onClick={handleDeleteWorkspace}
            disabled={currentWorkspace.owner_user_id !== user?.id}
          >
            Delete workspace
          </button>
        </div>
      )}
    </div>
  );
}
