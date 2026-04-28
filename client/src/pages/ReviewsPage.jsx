import React, { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

const SOURCES = [
  { value: 'steam', label: 'Steam', placeholder: 'e.g. 12210 (GTA V)' },
  { value: 'app-store', label: 'App Store', placeholder: 'e.g. 1234567890' },
  { value: 'play-store', label: 'Play Store', placeholder: 'e.g. com.example.app' },
];

// Reviews + sentiment dashboard. Wraps the cheap path:
//   POST /api/reviews/harvest { source, app_id, country?, limit? }
// → review-harvest.js does the rule-based sentiment classifier and returns
// { reviews, summary }. For LLM-powered theme extraction, users go to
// Agents → review-miner.
export default function ReviewsPage() {
  const { t } = useI18n();
  const toast = useToast();

  const [source, setSource] = useState('steam');
  const [appId, setAppId] = useState('');
  const [country, setCountry] = useState('us');
  const [limit, setLimit] = useState(200);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function handleHarvest(e) {
    e?.preventDefault?.();
    if (!appId.trim()) { toast.warning(t('reviews.app_id_required')); return; }
    setBusy(true);
    setResult(null);
    try {
      const r = await api.harvestReviews({
        source,
        app_id: appId.trim(),
        country,
        limit: parseInt(limit, 10) || 200,
      });
      setResult(r);
      toast.success(t('reviews.harvest_done', { count: r.reviews?.length || 0 }));
    } catch (err) {
      toast.error(err.message);
    }
    setBusy(false);
  }

  const summary = result?.summary;
  const reviews = result?.reviews || [];

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <h2>{t('reviews.title')}</h2>
        <p>{t('reviews.subtitle')}</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>{t('reviews.harvest_title')}</h3>
        <form onSubmit={handleHarvest}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 100px 100px', gap: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="reviews-source">{t('reviews.source')}</label>
              <select id="reviews-source" className="form-input" value={source} onChange={e => setSource(e.target.value)}>
                {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="reviews-appid">{t('reviews.app_id')}</label>
              <input
                id="reviews-appid"
                className="form-input"
                type="text"
                placeholder={SOURCES.find(s => s.value === source)?.placeholder}
                value={appId}
                onChange={e => setAppId(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="reviews-country">{t('reviews.country')}</label>
              <input
                id="reviews-country"
                className="form-input"
                type="text"
                value={country}
                onChange={e => setCountry(e.target.value.toLowerCase().slice(0, 2))}
                disabled={source === 'steam'}
                title={source === 'steam' ? t('reviews.country_na_steam') : ''}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="reviews-limit">{t('reviews.limit')}</label>
              <input
                id="reviews-limit"
                className="form-input"
                type="number"
                min="10"
                max="500"
                value={limit}
                onChange={e => setLimit(e.target.value)}
              />
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>{t('reviews.harvest_hint')}</p>
          <div style={{ marginTop: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t('reviews.harvesting') : t('reviews.harvest_btn')}
            </button>
          </div>
        </form>
      </div>

      {summary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{t('reviews.summary_title')}</h3>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                const apifyKey = source === 'steam' ? 'apify_steam_app_id'
                  : source === 'app-store' ? 'apify_app_store_app_id'
                  : 'apify_play_store_app_id';
                const input = {
                  product: appId,
                  audience_context: '',
                  [apifyKey]: appId,
                  apify_country: country,
                  apify_review_limit: parseInt(limit, 10) || 200,
                };
                const enc = encodeURIComponent(JSON.stringify(input));
                window.location.hash = `#/agents?run=review-miner&input=${enc}`;
              }}
              title={t('reviews.run_miner_title')}
            >
              {t('reviews.run_miner_btn')}
            </button>
          </div>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <div className="stat-card">
              <div className="stat-icon purple">∑</div>
              <div><div className="stat-value">{summary.total}</div><div className="stat-label">{t('reviews.summary_total')}</div></div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green">😊</div>
              <div>
                <div className="stat-value">{summary.positive_pct}%</div>
                <div className="stat-label">{t('reviews.summary_positive')}</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon red">😟</div>
              <div>
                <div className="stat-value">{summary.negative_pct}%</div>
                <div className="stat-label">{t('reviews.summary_negative')}</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon blue">⭐</div>
              <div>
                <div className="stat-value">{(summary.avg_rating || 0).toFixed(2)}</div>
                <div className="stat-label">{t('reviews.summary_rating')}</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon orange">😐</div>
              <div>
                <div className="stat-value">{summary.neutral}</div>
                <div className="stat-label">{t('reviews.summary_neutral')}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {reviews.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 16 }}>{t('reviews.list_title', { count: reviews.length })}</h3>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('reviews.col_rating')}</th>
                  <th>{t('reviews.col_sentiment')}</th>
                  <th>{t('reviews.col_author')}</th>
                  <th>{t('reviews.col_body')}</th>
                  <th>{t('reviews.col_date')}</th>
                </tr>
              </thead>
              <tbody>
                {reviews.slice(0, 200).map((r, i) => (
                  <tr key={r.review_id || i}>
                    <td>
                      <span style={{ color: 'var(--accent)' }}>{'★'.repeat(Math.round(r.rating || 0))}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{'★'.repeat(5 - Math.round(r.rating || 0))}</span>
                    </td>
                    <td>
                      <span className={`badge ${r.sentiment?.label === 'positive' ? 'badge-green' : r.sentiment?.label === 'negative' ? 'badge-red' : 'badge-gray'}`}>
                        {t(`reviews.sentiment_${r.sentiment?.label || 'neutral'}`)}
                      </span>
                    </td>
                    <td style={{ fontSize: 13 }}>{r.author_name || r.author_handle || '—'}</td>
                    <td style={{ fontSize: 13, maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.body}>
                      {r.body || '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            {t('reviews.advanced_hint')}
          </p>
        </div>
      )}
    </div>
  );
}
