import React, { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function AdsPage() {
  const toast = useToast();
  const { t } = useI18n();
  const [form, setForm] = useState({
    brand: '',
    product_url: '',
    objective: 'conversion',
    total_budget_usd: 5000,
    duration_days: 14,
    geo: 'US',
    audience_notes: '',
    platforms: ['meta', 'google_search', 'tiktok'],
  });
  const [plan, setPlan] = useState(null);
  const [cost, setCost] = useState(null);
  const [busy, setBusy] = useState(false);

  function update(key, value) { setForm(f => ({ ...f, [key]: value })); }

  function togglePlatform(p) {
    setForm(f => ({
      ...f,
      platforms: f.platforms.includes(p) ? f.platforms.filter(x => x !== p) : [...f.platforms, p],
    }));
  }

  async function handleGenerate() {
    if (!form.brand) return toast.error(t('ads.brand_required'));
    if (!form.total_budget_usd) return toast.error(t('ads.budget_required'));
    setBusy(true);
    setPlan(null);
    try {
      const r = await api.createAdsPlan({
        ...form,
        total_budget_usd: Number(form.total_budget_usd),
        duration_days: Number(form.duration_days) || 14,
      });
      setPlan(r.plan);
      setCost(r.cost);
      toast.success(t('ads.success'));
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('ads.title')}</h2>
          <p>{t('ads.subtitle')}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('ads.brief')}</h3>

          <Field label={t('ads.brand')}>
            <input className="input" value={form.brand} onChange={e => update('brand', e.target.value)} placeholder={t('ads.brand_placeholder')} />
          </Field>

          <Field label={t('ads.product_url')}>
            <input className="input" value={form.product_url} onChange={e => update('product_url', e.target.value)} placeholder={t('ads.product_url_placeholder')} />
          </Field>

          <Field label={t('ads.objective')}>
            <select className="input" value={form.objective} onChange={e => update('objective', e.target.value)}>
              <option value="awareness">{t('ads.objective_awareness')}</option>
              <option value="consideration">{t('ads.objective_consideration')}</option>
              <option value="conversion">{t('ads.objective_conversion')}</option>
              <option value="retargeting">{t('ads.objective_retargeting')}</option>
            </select>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label={t('ads.budget')}>
              <input className="input" type="number" min={100} value={form.total_budget_usd} onChange={e => update('total_budget_usd', e.target.value)} />
            </Field>
            <Field label={t('ads.duration')}>
              <input className="input" type="number" min={1} value={form.duration_days} onChange={e => update('duration_days', e.target.value)} />
            </Field>
          </div>

          <Field label={t('ads.geo')}>
            <input className="input" value={form.geo} onChange={e => update('geo', e.target.value)} placeholder={t('ads.geo_placeholder')} />
          </Field>

          <Field label={t('ads.audience_notes')}>
            <textarea
              className="input"
              value={form.audience_notes}
              onChange={e => update('audience_notes', e.target.value)}
              rows={3}
              placeholder={t('ads.audience_placeholder')}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
          </Field>

          <Field label={t('ads.platforms')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { id: 'meta', label: 'Meta (FB + IG)' },
                { id: 'google_search', label: 'Google Search' },
                { id: 'google_display', label: 'Google Display' },
                { id: 'tiktok', label: 'TikTok' },
                { id: 'youtube', label: 'YouTube' },
              ].map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={form.platforms.includes(p.id)} onChange={() => togglePlatform(p.id)} />
                  {p.label}
                </label>
              ))}
            </div>
          </Field>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={handleGenerate} disabled={busy}>
            {busy ? t('ads.running') : t('ads.run')}
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            {t('ads.round_trip_note')}
          </p>
        </div>

        <div>
          {!plan ? (
            <div className="card empty-state" style={{ minHeight: 300 }}>
              <p>{t('ads.empty')}</p>
              <p style={{ fontSize: 12 }}>{t('ads.empty_hint')}</p>
            </div>
          ) : (
            <PlanView plan={plan} cost={cost} t={t} />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

function PlanView({ plan, cost, t }) {
  const platformLabel = {
    meta: 'Meta', google_search: 'Google Search', google_display: 'Google Display',
    tiktok: 'TikTok', youtube: 'YouTube',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('ads.campaign_slug')}</div>
            <h3 style={{ margin: '2px 0 4px' }}>{plan.campaign_slug}</h3>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {plan.objective} · {t('ads.days_suffix', { n: plan.duration_days || '?' })} · ${plan.budget?.total_usd?.toLocaleString() || '?'}
            </div>
          </div>
          {plan.execution?.mode === 'offline_plan' && (
            <div style={{ padding: '4px 10px', borderRadius: 6, background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 600 }}>
              {t('ads.offline_plan')}
            </div>
          )}
        </div>
        {plan.execution?.note && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>{plan.execution.note}</p>
        )}
      </div>

      {plan.budget?.split && (
        <div className="card">
          <h4 style={{ marginTop: 0 }}>{t('ads.budget_split')}</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {plan.budget.split.map((s, i) => (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{platformLabel[s.platform] || s.platform}</span>
                  <span>{s.pct}% · ${((plan.budget.total_usd || 0) * s.pct / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <div style={{ height: 6, background: 'var(--surface-hover)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${s.pct}%`, background: 'var(--primary)' }} />
                </div>
                {s.rationale && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{s.rationale}</div>}
              </div>
            ))}
          </div>
          {plan.budget.pacing && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, marginBottom: 0 }}>
              <strong>{t('ads.pacing')}</strong> {plan.budget.pacing}
            </p>
          )}
        </div>
      )}

      {plan.kpis && (
        <div className="card">
          <h4 style={{ marginTop: 0 }}>{t('ads.kpis')}</h4>
          {plan.kpis.primary && <p style={{ marginTop: 0, marginBottom: 8 }}><strong>{t('ads.kpi_primary')}</strong> {plan.kpis.primary}</p>}
          {plan.kpis.secondary?.length > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              <strong>{t('ads.kpi_secondary')}</strong> {plan.kpis.secondary.join(' · ')}
            </p>
          )}
          {plan.kpis.rationale && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{plan.kpis.rationale}</p>
          )}
        </div>
      )}

      {(plan.platforms || []).map((p, i) => (
        <div key={i} className="card">
          <h4 style={{ marginTop: 0 }}>{platformLabel[p.platform] || p.platform}</h4>
          {p.bidding && <p style={{ fontSize: 13, margin: '0 0 12px' }}><strong>{t('ads.bidding')}</strong> {p.bidding}</p>}

          {p.audience && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{t('ads.audience_targeting')}</summary>
              <div style={{ fontSize: 13, paddingTop: 8 }}>
                {p.audience.demographics && <p style={{ margin: '0 0 6px' }}><strong>{t('ads.demographics')}</strong> {p.audience.demographics}</p>}
                {p.audience.interests?.length > 0 && <p style={{ margin: '0 0 6px' }}><strong>{t('ads.interests')}</strong> {p.audience.interests.join(', ')}</p>}
                {p.audience.behaviors?.length > 0 && <p style={{ margin: '0 0 6px' }}><strong>{t('ads.behaviors')}</strong> {p.audience.behaviors.join(', ')}</p>}
                {p.audience.lookalike_seed && <p style={{ margin: '0 0 6px' }}><strong>{t('ads.lookalike')}</strong> {p.audience.lookalike_seed}</p>}
                {p.audience.exclusions?.length > 0 && <p style={{ margin: '0 0 6px' }}><strong>{t('ads.exclusions')}</strong> {p.audience.exclusions.join(', ')}</p>}
              </div>
            </details>
          )}

          {p.utm && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{t('ads.utm')}</summary>
              <pre style={{ fontSize: 12, background: 'var(--surface-hover)', padding: 8, borderRadius: 4, marginTop: 8, overflow: 'auto' }}>
{`utm_source=${p.utm.utm_source || ''}
utm_medium=${p.utm.utm_medium || ''}
utm_campaign=${p.utm.utm_campaign || ''}`}
              </pre>
            </details>
          )}

          {p.creatives?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('ads.creatives', { count: p.creatives.length })}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {p.creatives.map((c, j) => (
                  <div key={j} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.headline}</div>
                    {c.hook && <div style={{ fontStyle: 'italic', color: 'var(--text-muted)', marginBottom: 6 }}>"{c.hook}"</div>}
                    {c.body && <div style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                      {c.cta && <span><strong>{t('ads.cta')}</strong> {c.cta}</span>}
                      {c.format && <span><strong>{t('ads.creative_format')}</strong> {c.format}</span>}
                    </div>
                    {c.visual_brief && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                        <strong>{t('ads.visual')}</strong> {c.visual_brief}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {plan.risks?.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid #f59e0b' }}>
          <h4 style={{ marginTop: 0 }}>{t('ads.risks')}</h4>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {plan.risks.map((r, i) => <li key={i} style={{ fontSize: 13, marginBottom: 4 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {cost?.usdCents != null && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
          {t('ads.generation_cost', { usd: (cost.usdCents / 100).toFixed(4), tokens: (cost.inputTokens || 0) + (cost.outputTokens || 0) })}
        </div>
      )}
    </div>
  );
}
