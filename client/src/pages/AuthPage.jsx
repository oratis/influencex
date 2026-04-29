import React, { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { useI18n } from '../i18n';
import PasswordInput from '../components/PasswordInput';
import FormField from '../components/FormField';

// Login-only page. Account creation is invite-only — admins send invitation
// links handled by AcceptInvitePage (/accept-invite?token=...).
export default function AuthPage() {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const { login } = useAuth();
  const { t } = useI18n();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoErr = params.get('sso_error');
    if (ssoErr) {
      setError(t('auth.google_failed', { error: decodeURIComponent(ssoErr) }));
      history.replaceState(null, '', window.location.pathname);
    }
    fetch('/api/auth/google/status').then(r => r.json()).then(d => setGoogleConfigured(!!d.configured)).catch(() => {});
  }, [t]);

  const handleGoogleSignIn = async () => {
    try {
      const r = await fetch('/api/auth/google/init').then(r => r.json());
      if (r.url) window.location.href = r.url;
      else setError(r.error || t('auth.google_unavailable'));
    } catch (e) { setError(e.message); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(form.email, form.password);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-header">
          <div className="auth-logo">
            <span className="auth-logo-icon">🎯</span>
            <h1>InfluenceX</h1>
          </div>
          <p className="auth-subtitle">{t('auth.subtitle')}</p>
        </div>

        <div className="auth-card">
          {googleConfigured && (
            <>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="btn auth-google-btn"
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 10, padding: '10px 16px', background: '#fff', color: '#1a1a1a',
                  border: '1px solid #dadce0', borderRadius: 8, fontSize: 14, fontWeight: 500,
                  marginBottom: 16, cursor: 'pointer',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {t('auth.continue_google')}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0', color: '#888', fontSize: 12 }}>
                <div style={{ flex: 1, height: 1, background: '#333' }} />
                <span>{t('auth.divider_or')}</span>
                <div style={{ flex: 1, height: 1, background: '#333' }} />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit}>
            <FormField label={t('auth.email')} required>
              <input
                className="form-input"
                type="email"
                placeholder={t('auth.email_placeholder')}
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                autoComplete="email"
                required
              />
            </FormField>
            <FormField label={t('auth.password')} required id="auth-password">
              <PasswordInput
                placeholder={t('auth.password_placeholder')}
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                autoComplete="current-password"
                required
              />
            </FormField>

            {error && (
              <div className="auth-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
              {loading ? t('auth.signing_in') : t('auth.sign_in')}
            </button>

            <p style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>
              <a href="#/forgot-password" style={{ color: 'var(--text-muted)' }}>{t('auth.forgot_password')}</a>
            </p>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0', color: '#888', fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: '#333' }} />
            <span>{t('auth.divider_or')}</span>
            <div style={{ flex: 1, height: 1, background: '#333' }} />
          </div>

          <a
            href="#/signup"
            className="btn btn-secondary auth-submit"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', textDecoration: 'none' }}
          >
            {t('auth.have_invite_code_btn')}
          </a>

          <div className="auth-footer">
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
              {t('auth.invite_only_note')}
            </p>
          </div>
        </div>

        <p className="auth-credit">{t('auth.powered_by')}</p>
      </div>
    </div>
  );
}
