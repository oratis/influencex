import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [myPerms, setMyPerms] = useState(null);
  const [roles, setRoles] = useState([]);
  const toast = useToast();
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirm();

  useEffect(() => {
    loadAll();
  }, []);

  const isAdmin = myPerms?.permissions?.includes('user.manage');

  async function loadAll() {
    setLoading(true);
    try {
      const [permRes, rolesRes] = await Promise.all([
        api.getMyPermissions(),
        api.getRoles(),
      ]);
      setMyPerms(permRes);
      setRoles(rolesRes.roles || []);
      if (permRes.permissions?.includes('user.manage')) {
        const u = await api.listUsers().catch(() => []);
        setUsers(u);
      }
    } catch (e) {
      toast.error(e.message);
    }
    setLoading(false);
  }

  async function handleChangeRole(u) {
    const currentIdx = roles.indexOf(u.role);
    const nextRole = roles[(currentIdx + 1) % roles.length];
    const ok = await confirmDialog(`Change role of ${u.email} from "${u.role}" to "${nextRole}"?`, {
      title: 'Change Role',
      confirmText: 'Change',
    });
    if (!ok) return;
    try {
      await api.updateUserRole(u.id, nextRole);
      toast.success(`Role updated to ${nextRole}`);
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleInvite() {
    const email = await promptDialog('Invitee email:', { title: 'Invite User', placeholder: 'user@example.com' });
    if (!email) return;
    const name = await promptDialog('Name:', { title: 'Invite User', placeholder: 'Full Name' });
    if (!name) return;
    const tempPw = await promptDialog('Temporary password (they can change later):', {
      title: 'Invite User',
      placeholder: 'At least 6 chars',
    });
    if (!tempPw) return;
    try {
      await api.inviteUser({ email, name, password: tempPw, role: 'editor' });
      toast.success(`Invited ${email} as editor`);
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDelete(u) {
    if (u.id === currentUser?.id) {
      toast.error('Cannot delete your own account');
      return;
    }
    const ok = await confirmDialog(`Permanently delete user ${u.email}?`, {
      title: 'Delete User',
      danger: true,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast.success('User deleted');
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (loading) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>Users</h2></div>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>Users</h2></div>
        <div className="empty-state">
          <h4>Admin access required</h4>
          <p>Your current role is <strong>{myPerms?.role || 'unknown'}</strong>. Only admins can manage users.</p>
        </div>
        {myPerms?.permissions && (
          <div className="card" style={{ marginTop: '16px' }}>
            <h3 style={{ marginBottom: '10px', fontSize: '15px' }}>Your Permissions ({myPerms.permissions.length})</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {myPerms.permissions.map(p => (
                <span key={p} className="badge badge-gray" style={{ fontSize: '11px' }}>{p}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>User Management</h2>
          <p>Invite members and assign roles</p>
        </div>
        <button className="btn btn-primary" onClick={handleInvite}>➕ Invite User</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon purple">👥</div>
          <div><div className="stat-value">{users.length}</div><div className="stat-label">Total Users</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red">🛡</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'admin').length}</div><div className="stat-label">Admins</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">✏</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'editor' || u.role === 'member').length}</div><div className="stat-label">Editors</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">👁</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'viewer').length}</div><div className="stat-label">Viewers</div></div>
        </div>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last Login</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="kol-avatar"><img src={u.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${u.name}`} alt="" /></div>
                      <div style={{ fontWeight: '600' }}>{u.name}{u.id === currentUser?.id && <span style={{ fontSize: '11px', color: 'var(--accent)', marginLeft: '6px' }}>(you)</span>}</div>
                    </div>
                  </td>
                  <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td>
                    <span className={`badge ${u.role === 'admin' ? 'badge-red' : u.role === 'editor' || u.role === 'member' ? 'badge-blue' : 'badge-gray'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {u.last_login ? new Date(u.last_login).toLocaleDateString() : '-'}
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}
                  </td>
                  <td>
                    <div className="btn-group">
                      <button className="btn btn-sm btn-secondary" onClick={() => handleChangeRole(u)} disabled={u.id === currentUser?.id}>
                        Change Role
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(u)} disabled={u.id === currentUser?.id}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
