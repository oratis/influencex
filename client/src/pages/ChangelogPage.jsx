import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const SEEN_KEY = 'influencex_changelog_last_seen_v1';

// Public release notes. Reads `/api/changelog` (the server parses
// docs/CHANGELOG.md into structured entries). On mount we mark the latest
// entry as "seen" so the sidebar's "What's new" badge clears.
export default function ChangelogPage() {
  const { t } = useI18n();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/changelog');
      const body = await res.json();
      setEntries(body.entries || []);
      const top = (body.entries || [])[0]?.date;
      if (top) localStorage.setItem(SEEN_KEY, top);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <h2>{t('changelog.title')}</h2>
        <p>{t('changelog.subtitle')}</p>
      </div>

      {loading && <div className="empty-state"><p>{t('common.loading')}</p></div>}
      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}

      {!loading && entries.length === 0 && !error && (
        <div className="empty-state">
          <p>{t('changelog.empty')}</p>
        </div>
      )}

      {entries.map((e, idx) => (
        <div key={`${e.date}-${idx}`} className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 17 }}>
                {e.codename || t('changelog.untitled')}
                {idx === 0 && <span className="badge badge-green" style={{ marginLeft: 10, fontSize: 10 }}>{t('changelog.latest')}</span>}
              </h3>
            </div>
            <code style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.date}</code>
          </div>

          <Section title={t('changelog.added')} items={e.added} accent="var(--success)" />
          <Section title={t('changelog.changed')} items={e.changed} accent="var(--info)" />
          <Section title={t('changelog.fixed')} items={e.fixed} accent="var(--warning)" />
          <Section title={t('changelog.removed')} items={e.removed} accent="var(--danger)" />
          {e.notes?.length > 0 && <Section title={t('changelog.notes')} items={e.notes} accent="var(--text-muted)" />}
        </div>
      ))}
    </div>
  );
}

function Section({ title, items, accent }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <h4 style={{
        margin: 0, marginBottom: 6, fontSize: 11, textTransform: 'uppercase',
        letterSpacing: 0.5, color: accent || 'var(--text-muted)',
      }}>{title}</h4>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}
