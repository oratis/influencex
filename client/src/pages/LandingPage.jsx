import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Public marketing landing page — shown at root when not authenticated.
 * Goal: get visitors to sign up or book a demo.
 */
export default function LandingPage() {
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
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text-secondary)', textDecoration: 'none' }}>GitHub</a>
          <a href="/api/docs" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text-secondary)', textDecoration: 'none' }}>API docs</a>
          <Link to="/login" className="btn btn-secondary btn-sm">Sign in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Start free</Link>
        </div>
      </div>

      {/* Hero */}
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
        <div style={{
          display: 'inline-block', padding: '6px 14px', fontSize: 12, fontWeight: 500,
          borderRadius: 14, border: '1px solid var(--accent)', color: 'var(--accent)',
          marginBottom: 24,
        }}>
          🚀 Open source · 8 AI agents · MIT licensed
        </div>
        <h1 style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, margin: '0 0 24px' }}>
          Your content marketing<br/>
          <span style={{ background: 'var(--gradient-1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            runs itself while you sleep.
          </span>
        </h1>
        <p style={{
          fontSize: 20, color: 'var(--text-secondary)', lineHeight: 1.5,
          maxWidth: 680, margin: '0 auto 36px',
        }}>
          A team of AI agents that plans, writes, designs, voices, and publishes your content across every channel.
          Creator discovery, outreach, and ROI tracking in one place.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 24 }}>
          <Link to="/signup" className="btn btn-primary" style={{ fontSize: 16, padding: '14px 28px' }}>
            Start free
          </Link>
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: 16, padding: '14px 28px' }}>
            ⭐ Star on GitHub
          </a>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No credit card · Self-hostable · Your keys, your data
        </div>
      </div>

      {/* Agents grid */}
      <div style={{ maxWidth: 1100, margin: '60px auto', padding: '0 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 32, marginBottom: 12 }}>8 AI agents. One platform.</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 40 }}>
          Each does one thing really well. The Conductor orchestrates them.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {[
            { emoji: '🎯', name: 'Strategy', desc: 'ICP, brand voice, content pillars, cadence.' },
            { emoji: '🔍', name: 'Research', desc: 'Trends, keywords, competitor snapshots.' },
            { emoji: '✍️', name: 'Content Writer', desc: '6 formats: Twitter, LinkedIn, blog, email, caption, YouTube Short.' },
            { emoji: '🎨', name: 'Visual', desc: 'Brand-consistent images via Doubao Seedream.' },
            { emoji: '🎙️', name: 'Voice', desc: 'Script → natural audio via ElevenLabs.' },
            { emoji: '🎬', name: 'Video', desc: 'Script + storyboard + voiceover in one blueprint.' },
            { emoji: '🚀', name: 'Publisher', desc: 'Platform-adapted text + 1-click intent URLs.' },
            { emoji: '👥', name: 'Discovery', desc: 'Find creators by keyword + engagement.' },
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
        <h2 style={{ textAlign: 'center', fontSize: 32, marginBottom: 40 }}>How it works</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {[
            { step: '1', title: 'Tell Conductor your goal', desc: '"Launch campaign X for SaaS founders in 30 days"' },
            { step: '2', title: 'AI builds a plan', desc: 'Strategy → research → content → design → publish. You approve.' },
            { step: '3', title: 'Agents execute', desc: 'Each agent runs its step. You watch progress in real time.' },
            { step: '4', title: 'Review + publish', desc: 'Every output saved to your library. Publish when ready.' },
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

      {/* Pricing */}
      <div style={{ maxWidth: 1100, margin: '80px auto', padding: '0 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 32, marginBottom: 12 }}>Pricing</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 40 }}>
          Self-host free forever. SaaS available soon.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {[
            { name: 'Open Source', price: 'Free', desc: 'Self-host on your infra. Bring your own LLM keys.', cta: 'View on GitHub', ctaUrl: 'https://github.com/oratis/influencex', featured: false },
            { name: 'Starter', price: '$49/mo', desc: '1 workspace. 5K agent tokens. 30 posts/mo. All agents.', cta: 'Start free trial', ctaUrl: '/signup', featured: true },
            { name: 'Growth', price: '$199/mo', desc: '3 workspaces. 50K tokens. 300 posts. Priority support.', cta: 'Start free trial', ctaUrl: '/signup', featured: false },
            { name: 'Enterprise', price: 'Custom', desc: 'SSO, SOC 2 prep, dedicated support, SLA.', cta: 'Talk to sales', ctaUrl: 'mailto:contact@influencexes.com', featured: false },
          ].map(t => (
            <div key={t.name} style={{
              padding: 24, borderRadius: 12,
              border: t.featured ? '2px solid var(--accent)' : '1px solid var(--border)',
              background: t.featured ? 'var(--accent-light)' : 'rgba(255,255,255,0.02)',
              position: 'relative',
            }}>
              {t.featured && <div style={{ position: 'absolute', top: -10, right: 16, fontSize: 10, background: 'var(--accent)', color: 'white', padding: '3px 10px', borderRadius: 10, fontWeight: 700 }}>MOST POPULAR</div>}
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{t.name}</div>
              <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 12 }}>{t.price}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 20, minHeight: 60 }}>{t.desc}</div>
              <a href={t.ctaUrl} target={t.ctaUrl.startsWith('http') || t.ctaUrl.startsWith('mailto') ? '_blank' : undefined} rel="noreferrer" className={`btn ${t.featured ? 'btn-primary' : 'btn-secondary'}`} style={{ width: '100%', justifyContent: 'center' }}>
                {t.cta}
              </a>
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
          <a href="https://github.com/oratis/influencex" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none', marginRight: 16 }}>GitHub</a>
          <a href="/api/docs" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none', marginRight: 16 }}>API docs</a>
          <a href="mailto:contact@influencexes.com" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Contact</a>
        </div>
        MIT licensed · InfluenceX {new Date().getFullYear()}
      </div>
    </div>
  );
}
