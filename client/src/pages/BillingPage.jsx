import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const BASE = import.meta.env.VITE_API_BASE || '/api';

function authHeaders() {
  const t = localStorage.getItem('influencex_token');
  const ws = window.__influencex_workspace_id;
  const h = { 'Content-Type': 'application/json' };
  if (t) h['Authorization'] = `Bearer ${t}`;
  if (ws) h['X-Workspace-Id'] = ws;
  return h;
}

export default function BillingPage() {
  const [plans, setPlans] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const { t } = useI18n();

  useEffect(() => {
    (async () => {
      try {
        const p = await fetch(`${BASE}/billing/plans`).then(r => r.json());
        setPlans(p.plans || []);
        setConfigured(!!p.configured);
      } catch (e) { setError(e.message); }
      try {
        const s = await fetch(`${BASE}/billing/subscription`, { headers: authHeaders() }).then(r => r.json());
        setSub(s);
      } catch { /* unauth etc */ }
      setLoading(false);
    })();

    const params = new URLSearchParams(window.location.search);
    if (params.get('stripe') === 'success') {
      setError('');
    }
  }, []);

  const startCheckout = async (planId) => {
    setBusy(planId); setError('');
    try {
      const r = await fetch(`${BASE}/billing/checkout`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ plan: planId }),
      }).then(r => r.json());
      if (r.url) window.location.href = r.url;
      else setError(r.error || t('billing.checkout_failed'));
    } catch (e) { setError(e.message); }
    setBusy(null);
  };

  const openPortal = async () => {
    setBusy('portal'); setError('');
    try {
      const r = await fetch(`${BASE}/billing/portal`, { method: 'POST', headers: authHeaders() }).then(r => r.json());
      if (r.url) window.location.href = r.url;
      else setError(r.error || t('billing.portal_unavailable'));
    } catch (e) { setError(e.message); }
    setBusy(null);
  };

  if (loading) return <div style={{ padding: 32 }}>{t('common.loading')}</div>;

  const currentPlan = sub?.plan || 'free';
  const stripeParam = new URLSearchParams(window.location.search).get('stripe');

  return (
    <div style={{ padding: 32, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>{t('billing.title')}</h1>
      <p style={{ color: '#888', marginBottom: 24 }}>
        {t('billing.current_plan')} <strong style={{ color: '#fff' }}>{currentPlan.toUpperCase()}</strong>
        {sub?.status && sub.status !== 'active' && <span style={{ color: '#f59e0b', marginLeft: 8 }}>({sub.status})</span>}
        {sub?.current_period_end && <span style={{ marginLeft: 12, color: '#666' }}>{t('billing.renews', { date: new Date(sub.current_period_end).toLocaleDateString() })}</span>}
      </p>

      {stripeParam === 'success' && (
        <div style={{ padding: 12, background: '#0f3a2a', color: '#22c55e', borderRadius: 8, marginBottom: 16 }}>
          {t('billing.payment_complete')}
        </div>
      )}
      {stripeParam === 'cancel' && (
        <div style={{ padding: 12, background: '#3a2a0f', color: '#f59e0b', borderRadius: 8, marginBottom: 16 }}>
          {t('billing.checkout_cancelled')}
        </div>
      )}
      {!configured && (
        <div style={{ padding: 12, background: '#2a1f0a', color: '#f59e0b', borderRadius: 8, marginBottom: 16 }}>
          {t('billing.stripe_not_configured')}
        </div>
      )}
      {error && <div style={{ padding: 12, background: '#2a0f0f', color: '#ef4444', borderRadius: 8, marginBottom: 16 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 32 }}>
        {plans.map(p => {
          const isCurrent = p.id === currentPlan;
          return (
            <div key={p.id} style={{
              border: `1px solid ${isCurrent ? '#8b5cf6' : '#2a2a35'}`,
              borderRadius: 12, padding: 20, background: '#0f0f18',
            }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>{p.label}</h3>
              <div style={{ fontSize: 28, fontWeight: 600, margin: '8px 0' }}>
                ${(p.price_cents / 100).toFixed(0)}<span style={{ fontSize: 14, color: '#888' }}>{t('billing.per_month')}</span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0', fontSize: 13, color: '#bbb' }}>
                {p.features.map((f, i) => <li key={i} style={{ padding: '4px 0' }}>• {f}</li>)}
              </ul>
              {isCurrent ? (
                <button disabled style={{ width: '100%', padding: 10, background: '#1a1a25', color: '#888', border: '1px solid #2a2a35', borderRadius: 8, cursor: 'default' }}>
                  {t('billing.current_plan_btn')}
                </button>
              ) : p.id === 'free' ? (
                <button disabled style={{ width: '100%', padding: 10, background: '#1a1a25', color: '#888', border: '1px solid #2a2a35', borderRadius: 8 }}>
                  —
                </button>
              ) : (
                <button
                  onClick={() => startCheckout(p.id)}
                  disabled={!p.available || busy === p.id}
                  style={{
                    width: '100%', padding: 10, background: p.available ? '#8b5cf6' : '#1a1a25',
                    color: '#fff', border: 'none', borderRadius: 8,
                    cursor: p.available ? 'pointer' : 'not-allowed', opacity: p.available ? 1 : 0.5,
                  }}
                >
                  {busy === p.id ? '…' : p.available ? t('billing.upgrade') : t('billing.coming_soon')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {sub?.stripe_customer_id && (
        <button
          onClick={openPortal}
          disabled={busy === 'portal'}
          style={{ padding: '10px 20px', background: '#1a1a25', color: '#fff', border: '1px solid #2a2a35', borderRadius: 8, cursor: 'pointer' }}
        >
          {busy === 'portal' ? '…' : t('billing.manage_portal')}
        </button>
      )}
    </div>
  );
}
