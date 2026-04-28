import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useCampaign } from '../CampaignContext';

const STORAGE_KEY = 'influencex_onboarding_done_v1';

// First-time user tour. Trigger conditions:
//   - User is logged in
//   - No localStorage flag yet
//   - Workspace has 0 campaigns (good proxy for "haven't done anything")
// We intentionally avoid stopping every returning user — once dismissed
// (Skip or Finish), the flag persists and the tour never auto-shows again.
// Users can re-launch via Cmd-K → "Start onboarding tour" later (a follow-up
// item; not implemented in v1).
const STEPS = [
  {
    key: 'welcome',
    titleKey: 'onboarding.step1_title',
    bodyKey: 'onboarding.step1_body',
  },
  {
    key: 'conductor',
    titleKey: 'onboarding.step2_title',
    bodyKey: 'onboarding.step2_body',
    cta: { labelKey: 'onboarding.step2_cta', path: '/conductor' },
  },
  {
    key: 'discovery',
    titleKey: 'onboarding.step3_title',
    bodyKey: 'onboarding.step3_body',
    cta: { labelKey: 'onboarding.step3_cta', path: '/discovery' },
  },
  {
    key: 'pipeline',
    titleKey: 'onboarding.step4_title',
    bodyKey: 'onboarding.step4_body',
    cta: { labelKey: 'onboarding.step4_cta', path: '/pipeline' },
  },
  {
    key: 'finish',
    titleKey: 'onboarding.step5_title',
    bodyKey: 'onboarding.step5_body',
  },
];

export default function OnboardingTour() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { campaigns, loading } = useCampaign();
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (campaigns && campaigns.length > 0) return;
    // Defer so it doesn't fire during the very first paint.
    const id = setTimeout(() => setOpen(true), 800);
    return () => clearTimeout(id);
  }, [loading, campaigns]);

  // Manual restart from the user menu dispatches this event. We bypass the
  // "no campaigns" guard so returning users can re-watch on demand.
  useEffect(() => {
    function handleRestart() {
      setStep(0);
      setOpen(true);
    }
    window.addEventListener('onboarding:restart', handleRestart);
    return () => window.removeEventListener('onboarding:restart', handleRestart);
  }, []);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  }

  function next() {
    if (step >= STEPS.length - 1) return dismiss();
    setStep(s => s + 1);
  }

  function prev() {
    setStep(s => Math.max(0, s - 1));
  }

  if (!open) return null;
  const s = STEPS[step];

  return (
    <div
      className="modal-overlay"
      onClick={dismiss}
      style={{ zIndex: 2400, alignItems: 'center', justifyContent: 'center' }}
      role="dialog"
      aria-labelledby="onboarding-title"
    >
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 480, width: '90%', padding: 24 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
            {t('onboarding.step_progress', { n: step + 1, total: STEPS.length })}
          </div>
          <button
            onClick={dismiss}
            aria-label={t('onboarding.skip')}
            title={t('onboarding.skip')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}
          >
            {t('onboarding.skip')}
          </button>
        </div>
        <h2 id="onboarding-title" style={{ marginTop: 0, marginBottom: 12, fontSize: 22 }}>{t(s.titleKey)}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: 20 }}>
          {t(s.bodyKey)}
        </p>

        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: 3,
                background: i <= step ? 'var(--accent)' : 'var(--bg-card)',
                borderRadius: 2,
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <div>
            {step > 0 && (
              <button className="btn btn-secondary" onClick={prev}>
                {t('onboarding.back')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {s.cta && (
              <button
                className="btn btn-secondary"
                onClick={() => { dismiss(); navigate(s.cta.path); }}
              >
                {t(s.cta.labelKey)}
              </button>
            )}
            <button className="btn btn-primary" onClick={next}>
              {step >= STEPS.length - 1 ? t('onboarding.finish') : t('onboarding.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
