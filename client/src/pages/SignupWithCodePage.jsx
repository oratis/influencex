import React, { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { useI18n } from '../i18n';
import PasswordInput from '../components/PasswordInput';

// Public signup page reachable at /#/signup or /#/signup?code=XXXX.
// Step 1: user enters/confirms an invite code → we look it up.
// Step 2: user fills name + email + password → POST /api/auth/register-with-code.
// On success the server returns a session token — we auto-login + redirect.
export default function SignupWithCodePage() {
  const { t } = useI18n();
  const { setSessionFromApi } = useAuth();

  const [code, setCode] = useState('');
  const [codeInfo, setCodeInfo] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const search = qIdx >= 0 ? hash.slice(qIdx) : window.location.search;
    const initial = new URLSearchParams(search).get('code');
    if (initial) {
      const upper = initial.trim().toUpperCase();
      setCode(upper);
      lookupCode(upper);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function lookupCode(value) {
    const trimmed = (value || code).trim().toUpperCase();
    if (!trimmed) return;
    setLookingUp(true);
    setLookupError('');
    setCodeInfo(null);
    try {
      const res = await fetch(`/api/invite-codes/lookup/${encodeURIComponent(trimmed)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const codeErr = body.code;
        if (codeErr === 'CODE_EXPIRED') setLookupError(t('signup.code_expired'));
        else if (codeErr === 'CODE_REVOKED') setLookupError(t('signup.code_revoked'));
        else if (codeErr === 'CODE_EXHAUSTED') setLookupError(t('signup.code_exhausted'));
        else if (codeErr === 'CODE_NOT_FOUND') setLookupError(t('signup.code_not_found'));
        else setLookupError(body.error || t('signup.code_invalid'));
      } else {
        setCodeInfo(body);
      }
    } catch (e) {
      setLookupError(e.message);
    }
    setLookingUp(false);
  }

  async function handleRegister(e) {
    e.preventDefault();
    setSubmitError('');
    if (!form.name.trim()) { setSubmitError(t('auth.please_enter_name')); return; }
    if (!form.email.trim()) { setSubmitError(t('signup.please_enter_email')); return; }
    if (form.password.length < 6) { setSubmitError(t('auth.password_too_short')); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/register-with-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          name: form.name.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.code === 'EMAIL_EXISTS') setSubmitError(t('signup.email_exists'));
        else if (body.code === 'CODE_EXHAUSTED') setSubmitError(t('signup.code_exhausted'));
        else if (body.code === 'CODE_EXPIRED') setSubmitError(t('signup.code_expired'));
        else if (body.code === 'CODE_REVOKED') setSubmitError(t('signup.code_revoked'));
        else if (body.code === 'CODE_RACE') setSubmitError(t('signup.code_race'));
        else setSubmitError(body.error || t('signup.failed'));
        setSubmitting(false);
        return;
      }
      if (typeof setSessionFromApi === 'function') {
        setSessionFromApi(body);
      } else if (body.token) {
        localStorage.setItem('influencex_token', body.token);
      }
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      setSubmitError(err.message);
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
          <p className="auth-subtitle">{t('signup.subtitle')}</p>
        </div>

        <div className="auth-card">
          {!codeInfo && (
            <form onSubmit={(e) => { e.preventDefault(); lookupCode(); }}>
              <div className="form-group">
                <label className="form-label" htmlFor="signup-code">{t('signup.code_label')}</label>
                <input
                  id="signup-code"
                  className="form-input"
                  type="text"
                  placeholder={t('signup.code_placeholder')}
                  value={code}
                  onChange={e => setCode(e.target.value.toUpperCase())}
                  autoComplete="off"
                  autoFocus
                  required
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                  {t('signup.code_hint')}
                </p>
              </div>
              {lookupError && (
                <div className="auth-error">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  {lookupError}
                </div>
              )}
              <button type="submit" className="btn btn-primary auth-submit" disabled={lookingUp || !code.trim()}>
                {lookingUp ? t('signup.checking_code') : t('signup.continue')}
              </button>
              <div className="auth-footer">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
                  {t('signup.have_account')} <a href="#/login" style={{ color: 'var(--accent)' }}>{t('auth.sign_in')}</a>
                </p>
              </div>
            </form>
          )}

          {codeInfo && (
            <form onSubmit={handleRegister}>
              <div style={{ background: 'var(--accent-light)', padding: 12, borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13 }}>
                <div style={{ marginBottom: 4 }}>
                  <strong>{t('signup.code_valid_title')}</strong>
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>
                  {t('signup.code_valid_detail', {
                    workspace: codeInfo.workspace_name || '—',
                    role: t(`roles.${codeInfo.role}`),
                    remaining: codeInfo.remaining_uses,
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => { setCodeInfo(null); setSubmitError(''); }}
                  style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                >
                  {t('signup.use_different_code')}
                </button>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="signup-name">{t('auth.name')}</label>
                <input
                  id="signup-name"
                  className="form-input"
                  type="text"
                  placeholder={t('auth.name_placeholder')}
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  autoComplete="name"
                  autoFocus
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="signup-email">{t('auth.email')}</label>
                <input
                  id="signup-email"
                  className="form-input"
                  type="email"
                  placeholder={t('auth.email_placeholder')}
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="signup-password">{t('auth.password')}</label>
                <PasswordInput
                  id="signup-password"
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
                {submitting ? t('signup.creating') : t('signup.create_account')}
              </button>
            </form>
          )}
        </div>
        <p className="auth-credit">{t('auth.powered_by')}</p>
      </div>
    </div>
  );
}
