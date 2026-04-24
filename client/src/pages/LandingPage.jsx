import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';

/**
 * Public marketing landing page — shown at root when not authenticated.
 * Goal: get visitors to sign up or book a demo.
 */
export default function LandingPage() {
  const { t } = useI18n();
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      backgroundImage:
        'radial-gradient(ellipse at 20% 0%, rgba(108, 92, 231, 0.12) 0%, transparent 60%), ' +
        'radial-gradient(ellipse at 80% 40%, rgba(0, 210, 160, 0.08) 0%, transparent 50%)',
      color: 'var(--text-primary)',
      width: '100%',
    }}>
      {/* Top nav */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 32px', maxWidth: 1200, margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 26 }}>🎯</span>
          <h1 style={{
            fontSize: 22, fontWeight: 800,
            background: 'var(--gradient-1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            margin: 0,
          }}>InfluenceX</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text-secondary)', textDecoration: 'none' }}>{t('landing.github')}</a>
          <a href="/api/docs" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text-secondary)', textDecoration: 'none' }}>{t('landing.api_docs')}</a>
          <Link to="/login" className="btn btn-secondary btn-sm">{t('auth.sign_in')}</Link>
          <Link to="/login" className="btn btn-primary btn-sm">{t('auth.sign_in')}</Link>
        </div>
      </div>

      {/* Hero */}
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
        <div style={{
          display: 'inline-block', padding: '6px 14px', fontSize: 12, fontWeight: 500,
          borderRadius: 14, border: '1px solid var(--accent)', color: 'var(--accent)',
          marginBottom: 24,
        }}>
          {t('landing.hero_badge')}
        </div>
        <h1 style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, margin: '0 0 24px' }}>
          {t('landing.hero_title_line1')}<br/>
          <span style={{ background: 'var(--gradient-1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {t('landing.hero_title_line2')}
          </span>
        </h1>
        <p style={{
          fontSize: 20, color: 'var(--text-secondary)', lineHeight: 1.5,
          maxWidth: 680, margin: '0 auto 36px',
        }}>
          {t('landing.hero_subtitle')}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 24 }}>
          <Link to="/login" className="btn btn-primary" style={{ fontSize: 16, padding: '14px 28px' }}>
            {t('auth.sign_in')}
          </Link>
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: 16, padding: '14px 28px' }}>
            {t('landing.star_on_github')}
          </a>
        </div>
      </div>

      {/* Agents grid */}
      <div style={{ maxWidth: 1100, margin: '60px auto', padding: '0 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 32, marginBottom: 12 }}>{t('landing.agents_title')}</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 40 }}>
          {t('landing.agents_subtitle')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {[
            { emoji: '🎯', name: t('nav.conductor'), desc: t('landing.agent_strategy_desc') },
            { emoji: '🔍', name: t('landing.agent_research_desc') ? 'Research' : 'Research', desc: t('landing.agent_research_desc') },
            { emoji: '✍️', name: t('landing.agent_writer'), desc: t('landing.agent_writer_desc') },
            { emoji: '🎨', name: t('landing.agent_visual'), desc: t('landing.agent_visual_desc') },
            { emoji: '🎙️', name: t('landing.agent_voice'), desc: t('landing.agent_voice_desc') },
            { emoji: '🎬', name: t('landing.agent_video'), desc: t('landing.agent_video_desc') },
            { emoji: '🚀', name: t('landing.agent_publisher'), desc: t('landing.agent_publisher_desc') },
            { emoji: '👥', name: t('landing.agent_discovery'), desc: t('landing.agent_discovery_desc') },
          ].map(a => (
            <div key={a.name} style={{
              padding: 20, borderRadius: 12, border: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>{a.emoji}</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{a.name}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{a.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div style={{ maxWidth: 1100, margin: '80px auto', padding: '0 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 32, marginBottom: 40 }}>{t('landing.how_it_works')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {[
            { step: '1', title: t('landing.step1_title'), desc: t('landing.step1_desc') },
            { step: '2', title: t('landing.step2_title'), desc: t('landing.step2_desc') },
            { step: '3', title: t('landing.step3_title'), desc: t('landing.step3_desc') },
            { step: '4', title: t('landing.step4_title'), desc: t('landing.step4_desc') },
          ].map(s => (
            <div key={s.step} style={{ textAlign: 'center' }}>
              <div style={{
                width: 48, height: 48, margin: '0 auto 12px', borderRadius: 24,
                background: 'var(--gradient-1)', color: 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 18,
              }}>{s.step}</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        borderTop: '1px solid var(--border)', marginTop: 80, padding: '40px 24px',
        textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
      }}>
        <div style={{ marginBottom: 10 }}>
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none', marginRight: 16 }}>{t('landing.github')}</a>
          <a href="/api/docs" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none', marginRight: 16 }}>{t('landing.api_docs')}</a>
          <a href="mailto:contact@influencexes.com" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>{t('landing.contact')}</a>
        </div>
        {t('landing.mit_footer', { year: new Date().getFullYear() })}
      </div>
    </div>
  );
}
