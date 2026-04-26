import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api/client';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

// Admin-only page for creating + revoking generic invite codes that anyone
// can use to register. Distinct from the per-email invitation flow on
// /workspace/settings: codes here are sharable strings (e.g. "INFLX-7K3M9X")
// with optional usage limits and expiry.
export default function InviteCodesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm } = useConfirm();

  const [codes, setCodes] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [justCreated, setJustCreated] = useState(null); // most recently created code — shown in highlight panel

  const [form, setForm] = useState({
    workspaceId: '',
    role: 'editor',
    maxUses: 5,
    expiresInDays: 30,
    note: '',
  });
  const [creating, setCreating] = useState(false);

  const isPlatformAdmin = user?.role === 'admin';

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [codesRes, wsRes] = await Promise.all([
        api.listInviteCodes().catch(e => { if (e.statusCode === 403) return { codes: [] }; throw e; }),
        api.listWorkspaces().catch(() => ({ workspaces: [] })),
      ]);
      setCodes(codesRes.codes || []);
      const wsList = wsRes.workspaces || wsRes || [];
      setWorkspaces(wsList);
      if (!form.workspaceId && wsList.length) {
        setForm(f => ({ ...f, workspaceId: wsList[0].id }));
      }
    } catch (e) {
      toast.error(e.message);
    }
    setLoading(false);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.workspaceId) { toast.error(t('invite_codes.error_select_workspace')); return; }
    setCreating(true);
    try {
      const created = await api.createInviteCode({
        workspaceId: form.workspaceId,
        role: form.role,
        maxUses: parseInt(form.maxUses, 10) || 1,
        expiresInDays: form.expiresInDays ? parseInt(form.expiresInDays, 10) : null,
        note: form.note?.trim() || null,
      });
      toast.success(t('invite_codes.created', { code: created.code }));
      setJustCreated(created);
      setForm(f => ({ ...f, note: '' }));
      loadAll();
    } catch (err) {
      toast.error(err.message);
    }
    setCreating(false);
  }

  async function handleRevoke(c) {
    const ok = await confirm(t('invite_codes.confirm_revoke', { code: c.code }), {
      title: t('invite_codes.revoke_title'),
      danger: true,
      confirmText: t('invite_codes.btn_revoke'),
    });
    if (!ok) return;
    try {
      await api.revokeInviteCode(c.id);
      toast.success(t('invite_codes.revoked'));
      loadAll();
    } catch (err) { toast.error(err.message); }
  }

  function handleCopy(code) {
    navigator.clipboard?.writeText(code).then(
      () => toast.success(t('invite_codes.copied')),
      () => toast.error('Copy failed')
    );
  }

  function signupLink(code) {
    return `${window.location.origin}/#/signup?code=${encodeURIComponent(code)}`;
  }

  function statusFor(c) {
    if (c.revoked_at) return { key: 'revoked', cls: 'badge-gray' };
    if (c.expires_at && new Date(c.expires_at) < new Date()) return { key: 'expired', cls: 'badge-gray' };
    if (c.used_count >= c.max_uses) return { key: 'exhausted', cls: 'badge-gray' };
    return { key: 'active', cls: 'badge-green' };
  }

  const sortedCodes = useMemo(() => {
    return [...codes].sort((a, b) => {
      const aActive = !a.revoked_at && (!a.expires_at || new Date(a.expires_at) > new Date()) && a.used_count < a.max_uses;
      const bActive = !b.revoked_at && (!b.expires_at || new Date(b.expires_at) > new Date()) && b.used_count < b.max_uses;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }, [codes]);

  if (!isPlatformAdmin) {
    return (
      <div className="page-container fade-in">
        <div className="page-header"><h2>{t('invite_codes.title')}</h2></div>
        <div className="empty-state">
          <h4>{t('invite_codes.admin_required_title')}</h4>
          <p>{t('invite_codes.admin_required_hint')}</p>
        </div>
      </div>
    );
  }

  const noWorkspaces = !loading && workspaces.length === 0;

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <h2>{t('invite_codes.title')}</h2>
        <p>{t('invite_codes.subtitle')}</p>
      </div>

      {justCreated && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent)', background: 'var(--accent-light)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 16, color: 'var(--accent)' }}>
                {t('invite_codes.share_title')}
              </h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                {t('invite_codes.share_subtitle')}
              </p>
            </div>
            <button
              className="btn-icon"
              onClick={() => setJustCreated(null)}
              aria-label={t('common.close')}
              title={t('common.close')}
            >✕</button>
          </div>
          <div style={{ background: 'var(--bg-card)', padding: 12, borderRadius: 'var(--radius-sm)', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t('invite_codes.col_code')}
            </div>
            <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 18, color: 'var(--accent)', fontWeight: 600 }}>
              {justCreated.code}
            </code>
          </div>
          <div style={{ background: 'var(--bg-card)', padding: 12, borderRadius: 'var(--radius-sm)', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t('invite_codes.share_link_label')}
            </div>
            <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
              {signupLink(justCreated.code)}
            </code>
          </div>
          <div className="btn-group" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(justCreated.code)}>
              {t('invite_codes.btn_copy_code')}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(signupLink(justCreated.code))}>
              {t('invite_codes.btn_copy_link')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleCopy(t('invite_codes.share_message_template', { code: justCreated.code, link: signupLink(justCreated.code), workspace: workspaces.find(w => w.id === justCreated.workspace_id)?.name || '' }))}
            >
              {t('invite_codes.btn_copy_message')}
            </button>
          </div>
        </div>
      )}

      {noWorkspaces && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="empty-state">
            <h4>{t('invite_codes.no_workspace_title')}</h4>
            <p>{t('invite_codes.no_workspace_hint')}</p>
            <a href="#/workspace/settings" className="btn btn-primary btn-sm" style={{ marginTop: 12, display: 'inline-block', textDecoration: 'none' }}>
              {t('invite_codes.no_workspace_cta')}
            </a>
          </div>
        </div>
      )}

      {!noWorkspaces && (
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>{t('invite_codes.create_title')}</h3>
        <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ic-workspace">{t('invite_codes.field_workspace')}</label>
            <select
              id="ic-workspace"
              className="form-input"
              value={form.workspaceId}
              onChange={e => setForm(f => ({ ...f, workspaceId: e.target.value }))}
              required
            >
              {workspaces.length === 0 && <option value="">—</option>}
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ic-role">{t('invite_codes.field_role')}</label>
            <select
              id="ic-role"
              className="form-input"
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            >
              <option value="editor">{t('roles.editor')}</option>
              <option value="viewer">{t('roles.viewer')}</option>
              <option value="admin">{t('roles.admin')}</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ic-maxuses">{t('invite_codes.field_max_uses')}</label>
            <input
              id="ic-maxuses"
              className="form-input"
              type="number"
              min="1"
              max="1000"
              value={form.maxUses}
              onChange={e => setForm(f => ({ ...f, maxUses: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ic-expires">{t('invite_codes.field_expires')}</label>
            <input
              id="ic-expires"
              className="form-input"
              type="number"
              min="1"
              max="365"
              placeholder={t('invite_codes.placeholder_no_expiry')}
              value={form.expiresInDays}
              onChange={e => setForm(f => ({ ...f, expiresInDays: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
            <label className="form-label" htmlFor="ic-note">{t('invite_codes.field_note')}</label>
            <input
              id="ic-note"
              className="form-input"
              type="text"
              placeholder={t('invite_codes.placeholder_note')}
              value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              maxLength={120}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? t('invite_codes.creating') : t('invite_codes.btn_create')}
            </button>
          </div>
        </form>
      </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>{t('invite_codes.list_title', { count: codes.length })}</h3>
        </div>

        {loading ? (
          <div className="empty-state"><p>{t('common.loading')}</p></div>
        ) : codes.length === 0 ? (
          <div className="empty-state">
            <p>{t('invite_codes.empty')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('invite_codes.col_code')}</th>
                  <th>{t('invite_codes.col_workspace')}</th>
                  <th>{t('invite_codes.col_role')}</th>
                  <th>{t('invite_codes.col_uses')}</th>
                  <th>{t('invite_codes.col_expires')}</th>
                  <th>{t('invite_codes.col_status')}</th>
                  <th>{t('invite_codes.col_note')}</th>
                  <th>{t('invite_codes.col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedCodes.map(c => {
                  const st = statusFor(c);
                  const active = st.key === 'active';
                  return (
                    <tr key={c.id}>
                      <td>
                        <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: 'var(--accent)' }}>{c.code}</code>
                      </td>
                      <td style={{ fontSize: 13 }}>{c.workspace_name || c.workspace_id}</td>
                      <td>
                        <span className={`badge ${c.role === 'admin' ? 'badge-red' : c.role === 'editor' ? 'badge-blue' : 'badge-gray'}`}>
                          {t(`roles.${c.role}`)}
                        </span>
                      </td>
                      <td style={{ fontSize: 13 }}>{c.used_count} / {c.max_uses}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : t('invite_codes.no_expiry')}
                      </td>
                      <td>
                        <span className={`badge ${st.cls}`}>{t(`invite_codes.status_${st.key}`)}</span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.note || ''}>
                        {c.note || '—'}
                      </td>
                      <td>
                        <div className="btn-group">
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleCopy(c.code)}
                            disabled={!active}
                            title={t('invite_codes.btn_copy_code_title')}
                          >
                            {t('invite_codes.btn_copy_code')}
                          </button>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleCopy(signupLink(c.code))}
                            disabled={!active}
                            title={t('invite_codes.btn_copy_link_title')}
                          >
                            {t('invite_codes.btn_copy_link')}
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleRevoke(c)}
                            disabled={!!c.revoked_at}
                          >
                            {t('invite_codes.btn_revoke')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
