import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import PasswordInput from '../components/PasswordInput';

// Public page reached via the reset link: /#/reset-password?token=xxx.
// User enters new password; we POST it + token, server verifies + updates.
// On success we direct them to log in with the new password (we do NOT
// auto-login because the token is one-shot and password reset should be a
// deliberate action).
export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const search = qIdx >= 0 ? hash.slice(qIdx) : window.location.search;
    const tok = new URLSearchParams(search).get('token');
    setToken(tok || '');
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!token) { setError(t('reset_password.no_token')); return; }
    if (password.length < 6) { setError(t('auth.password_too_short')); return; }
    if (password !== confirm) { setError(t('reset_password.mismatch')); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.code === 'TOKEN_USED') setError(t('reset_password.token_used'));
        else if (body.code === 'TOKEN_EXPIRED') setError(t('reset_password.token_expired'));
        else if (body.code === 'TOKEN_NOT_FOUND') setError(t('reset_password.token_invalid'));
        else setError(body.error || t('reset_password.failed'));
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-header">
          <div className="auth-logo">
            <span className="auth-logo-icon">🎯</span>
            <h1>InfluenceX</h1>
          </div>
          <p className="auth-subtitle">{t('reset_password.subtitle')}</p>
        </div>

        <div className="auth-card">
          {done ? (
            <>
              <p style={{ fontSize: 14, color: 'var(--success)', marginBottom: 12 }}>
                ✓ {t('reset_password.success')}
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {t('reset_password.success_body')}
              </p>
              <a href="#/login" className="btn btn-primary auth-submit" style={{ textAlign: 'center', textDecoration: 'none', marginTop: 16 }}>
                {t('auth.sign_in')}
              </a>
            </>
          ) : !token ? (
            <>
              <div className="auth-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {t('reset_password.no_token')}
              </div>
              <a href="#/forgot-password" className="btn btn-primary auth-submit" style={{ textAlign: 'center', textDecoration: 'none' }}>
                {t('forgot_password.send_link')}
              </a>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="reset-password">{t('reset_password.new_password')}</label>
                <PasswordInput
                  id="reset-password"
                  placeholder={t('auth.password_new_placeholder')}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="reset-confirm">{t('reset_password.confirm_password')}</label>
                <PasswordInput
                  id="reset-confirm"
                  placeholder={t('reset_password.confirm_placeholder')}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              {error && (
                <div className="auth-error">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  {error}
                </div>
              )}
              <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
                {submitting ? t('reset_password.submitting') : t('reset_password.submit')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
