import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

export default function UsersPage() {
  const { t } = useI18n();
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
    const ok = await confirmDialog(t('users.change_role_confirm', { email: u.email, from: u.role, to: nextRole }), {
      title: t('users.change_role_title'),
      confirmText: t('users.change_role_btn_confirm'),
    });
    if (!ok) return;
    try {
      await api.updateUserRole(u.id, nextRole);
      toast.success(t('users.role_changed', { role: nextRole }));
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleInvite() {
    const email = await promptDialog(t('users.invite_email_prompt'), { title: t('users.invite_title'), placeholder: t('users.invite_email_placeholder') });
    if (!email) return;
    const name = await promptDialog(t('users.invite_name_prompt'), { title: t('users.invite_title'), placeholder: t('users.invite_name_placeholder') });
    if (!name) return;
    const tempPw = await promptDialog(t('users.invite_pw_prompt'), {
      title: t('users.invite_title'),
      placeholder: t('users.invite_pw_placeholder'),
    });
    if (!tempPw) return;
    try {
      await api.inviteUser({ email, name, password: tempPw, role: 'editor' });
      toast.success(t('users.invited', { email }));
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDelete(u) {
    if (u.id === currentUser?.id) {
      toast.error(t('users.cannot_delete_self'));
      return;
    }
    const ok = await confirmDialog(t('users.confirm_delete', { email: u.email }), {
      title: t('users.delete_title'),
      danger: true,
      confirmText: t('users.delete_btn_confirm'),
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast.success(t('users.deleted'));
      loadAll();
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (loading) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('users.title')}</h2></div>
        <div className="empty-state"><p>{t('users.loading')}</p></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('users.title')}</h2></div>
        <div className="empty-state">
          <h4>{t('users.admin_required_title')}</h4>
          <p>{t('users.admin_required_hint', { role: myPerms?.role || '—' })}</p>
        </div>
        {myPerms?.permissions && (
          <div className="card" style={{ marginTop: '16px' }}>
            <h3 style={{ marginBottom: '10px', fontSize: '15px' }}>{t('users.your_permissions', { count: myPerms.permissions.length })}</h3>
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
          <h2>{t('users.title_management')}</h2>
          <p>{t('users.subtitle')}</p>
        </div>
        <button className="btn btn-primary" onClick={handleInvite}>{t('users.invite_user')}</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card">
          <div className="stat-icon purple">👥</div>
          <div><div className="stat-value">{users.length}</div><div className="stat-label">{t('users.stat_total_users')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red">🛡</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'admin').length}</div><div className="stat-label">{t('users.stat_admins')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">✏</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'editor' || u.role === 'member').length}</div><div className="stat-label">{t('users.stat_editors')}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">👁</div>
          <div><div className="stat-value">{users.filter(u => u.role === 'viewer').length}</div><div className="stat-label">{t('users.stat_viewers')}</div></div>
        </div>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>{t('users.col_user')}</th>
                <th>{t('users.col_email')}</th>
                <th>{t('users.col_role')}</th>
                <th>{t('users.col_last_login')}</th>
                <th>{t('users.col_created')}</th>
                <th>{t('users.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="kol-avatar"><img src={u.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${u.name}`} alt="" /></div>
                      <div style={{ fontWeight: '600' }}>{u.name}{u.id === currentUser?.id && <span style={{ fontSize: '11px', color: 'var(--accent)', marginLeft: '6px' }}>{t('users.you_tag')}</span>}</div>
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
                        {t('users.btn_change_role')}
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(u)} disabled={u.id === currentUser?.id}>
                        {t('users.btn_delete')}
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
