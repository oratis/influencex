import React, { useState } from 'react';
import { useI18n } from '../i18n';

// Public page: enter email, request a reset link.
// We never tell the user whether the email exists — the API returns 200
// regardless to prevent account enumeration.
export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError(t('forgot_password.email_required')); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t('forgot_password.failed'));
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
          <p className="auth-subtitle">{t('forgot_password.subtitle')}</p>
        </div>

        <div className="auth-card">
          {done ? (
            <>
              <p style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>
                ✓ {t('forgot_password.success_title')}
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {t('forgot_password.success_body')}
              </p>
              <a href="#/login" className="btn btn-primary auth-submit" style={{ textAlign: 'center', textDecoration: 'none', marginTop: 16 }}>
                {t('auth.sign_in')}
              </a>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
                {t('forgot_password.intro')}
              </p>
              <div className="form-group">
                <label className="form-label" htmlFor="forgot-email">{t('auth.email')}</label>
                <input
                  id="forgot-email"
                  className="form-input"
                  type="email"
                  placeholder={t('auth.email_placeholder')}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
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
                {submitting ? t('forgot_password.sending') : t('forgot_password.send_link')}
              </button>
              <div className="auth-footer">
                <p style={{ fontSize: 13, textAlign: 'center', marginTop: 12 }}>
                  <a href="#/login" style={{ color: 'var(--accent)' }}>{t('forgot_password.back_to_login')}</a>
                </p>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
