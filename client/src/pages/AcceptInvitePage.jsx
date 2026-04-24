import React, { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { useI18n } from '../i18n';

// Invite-acceptance page reached via /#/accept-invite?token=... shared by an
// admin. We:
//   1. GET /api/invitations/:token to look up the workspace name + email
//   2. POST /api/invitations/:token/accept with password + name
//   3. Auto-login on success and redirect into the app
//
// No signup path exists outside this flow — if the token is missing/expired/
// used we render a helpful error instead of a form.
export default function AcceptInvitePage() {
  const { t } = useI18n();
  const { setSessionFromApi } = useAuth();
  const [token, setToken] = useState(null);
  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ name: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    // Hash router puts the query string after the hash, e.g.
    // /#/accept-invite?token=xxx. URL.searchParams won't find it there.
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const search = qIdx >= 0 ? hash.slice(qIdx) : window.location.search;
    const tok = new URLSearchParams(search).get('token');
    if (!tok) {
      setLoadError(t('auth.accept_invite_not_found'));
      setLoading(false);
      return;
    }
    setToken(tok);
    fetch(`/api/invitations/${encodeURIComponent(tok)}`)
      .then(r => r.json().then(body => ({ ok: r.ok, status: r.status, body })))
      .then(({ ok, status, body }) => {
        if (!ok) {
          if (body.code === 'INVITE_EXPIRED') setLoadError(t('auth.accept_invite_expired'));
          else if (body.code === 'INVITE_USED') setLoadError(t('auth.accept_invite_used'));
          else setLoadError(body.error || t('auth.accept_invite_not_found'));
          return;
        }
        setInvite(body);
      })
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [t]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    if (!form.name.trim()) { setSubmitError(t('auth.please_enter_name')); return; }
    if (form.password.length < 6) { setSubmitError(t('auth.password_too_short')); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), password: form.password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.code === 'EMAIL_EXISTS') setSubmitError(t('auth.accept_invite_email_exists'));
        else setSubmitError(body.error || 'Failed');
        setSubmitting(false);
        return;
      }
      // AuthContext exposes a way to seed the session from a login response;
      // fallback is to trigger a reload after persisting the token.
      if (typeof setSessionFromApi === 'function') {
        setSessionFromApi(body);
      } else if (body.token) {
        localStorage.setItem('influencex_token', body.token);
      }
      window.location.hash = '#/';
      window.location.reload();
    } catch (e) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-container">
          <div className="auth-card"><p style={{ textAlign: 'center' }}>{t('common.loading')}</p></div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="auth-page">
        <div className="auth-container">
          <div className="auth-header">
            <div className="auth-logo"><span className="auth-logo-icon">🎯</span><h1>InfluenceX</h1></div>
          </div>
          <div className="auth-card">
            <div className="auth-error">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              {loadError}
            </div>
            <a href="#/login" className="btn btn-primary auth-submit" style={{ textAlign: 'center' }}>{t('auth.sign_in')}</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-header">
          <div className="auth-logo"><span className="auth-logo-icon">🎯</span><h1>InfluenceX</h1></div>
          <p className="auth-subtitle">{t('auth.accept_invite_title', { workspace: invite?.workspace_name || '—' })}</p>
        </div>
        <div className="auth-card">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('auth.accept_invite_subtitle')}</p>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">{t('auth.email')}</label>
              <input className="form-input" type="email" value={invite?.email || ''} disabled readOnly />
            </div>
            <div className="form-group">
              <label className="form-label">{t('auth.name')}</label>
              <input
                className="form-input"
                type="text"
                placeholder={t('auth.name_placeholder')}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                autoComplete="name"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('auth.password')}</label>
              <input
                className="form-input"
                type="password"
                placeholder={t('auth.password_new_placeholder')}
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                autoComplete="new-password"
                required
              />
            </div>

            {submitError && (
              <div className="auth-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {submitError}
              </div>
            )}

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? t('auth.accept_invite_loading') : t('auth.accept_invite_btn')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
