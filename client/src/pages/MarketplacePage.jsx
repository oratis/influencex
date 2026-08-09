import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, toastApiError } from '../api/client';
import { useCampaign } from '../CampaignContext';
import { useAuth } from '../AuthContext';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import ErrorCard from '../components/ErrorCard';
import FormField from '../components/FormField';

// Creator Marketplace (roadmap D2).
//
// Browses the shared cross-workspace catalog (`creators_public`). Everything
// on this page is public profile data — handle, audience size, engagement,
// category, profile URL. The API has no contact fields to give us, which is
// the point; see the section comment above the routes in server/index.js.
//
// Sample rows are rendered with a visible badge and their "add to campaign"
// button is disabled: they are demo scaffolding, not people, and a `kols` row
// has nowhere to carry that caveat.

const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'twitter', 'reddit'];

const EMPTY_FILTERS = {
  platform: '',
  category: '',
  min_followers: '',
  q: '',
  sort: 'followers',
};

function formatFollowers(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export default function MarketplacePage() {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const { selectedCampaignId, selectedCampaign } = useCampaign();

  // `draft` is what the user is typing; `applied` is what the last request
  // used. Keeping them separate means no request-per-keystroke and no
  // out-of-order responses from a debounce race.
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, limit: 24, offset: 0, categories: [], has_sample: false });
  const [addingId, setAddingId] = useState(null);
  const [contributing, setContributing] = useState(false);

  // Guards against a slow earlier response overwriting a newer one.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getMarketplaceCreators({ ...applied, offset });
      if (seq !== requestSeq.current) return;
      setData({
        items: res.items || [],
        total: res.total || 0,
        limit: res.limit || 24,
        offset: res.offset || 0,
        categories: res.categories || [],
        has_sample: !!res.has_sample,
      });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [applied, offset]);

  useEffect(() => { load(); }, [load]);

  function handleApply(e) {
    e?.preventDefault?.();
    setOffset(0);
    setApplied(draft);
  }

  function handleReset() {
    setDraft(EMPTY_FILTERS);
    setOffset(0);
    setApplied(EMPTY_FILTERS);
  }

  async function handleAdd(creator) {
    if (!selectedCampaignId) { toast.warning(t('marketplace.no_campaign')); return; }
    setAddingId(creator.id);
    try {
      await api.addMarketplaceCreatorToCampaign(creator.id, selectedCampaignId);
      toast.success(t('marketplace.added_toast', {
        name: creator.display_name || creator.username,
        campaign: selectedCampaign?.name || selectedCampaignId,
      }));
    } catch (err) {
      if (err.code === 'ALREADY_IN_CAMPAIGN') {
        toast.info(t('marketplace.already_in_campaign', { name: creator.display_name || creator.username }));
      } else if (err.code === 'SAMPLE_NOT_ADDABLE') {
        toast.warning(t('marketplace.add_sample_disabled'));
      } else {
        toastApiError(err, toast, t);
      }
    } finally {
      setAddingId(null);
    }
  }

  async function handleContribute() {
    setContributing(true);
    try {
      const res = await api.contributeToMarketplace();
      toast.success(t('marketplace.contribute_done', {
        contributed: res.contributed || 0,
        refreshed: res.refreshed || 0,
        skipped: res.skipped || 0,
      }));
      // Reload so newly listed creators appear. Changing offset already
      // re-runs the effect; otherwise fetch explicitly.
      if (offset !== 0) setOffset(0); else load();
    } catch (err) {
      toastApiError(err, toast, t);
    } finally {
      setContributing(false);
    }
  }

  const { items, total, limit, categories, has_sample: hasSample } = data;
  const hasFilters = Object.keys(EMPTY_FILTERS).some(k => applied[k] !== EMPTY_FILTERS[k]);
  const showEmpty = !loading && !loadError && items.length === 0;

  return (
    <div className="page-container fade-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h2>{t('marketplace.title')}</h2>
          <p>{t('marketplace.subtitle')}</p>
        </div>
        {user?.role === 'admin' && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleContribute}
            disabled={contributing}
            title={t('marketplace.contribute_title')}
          >
            {contributing ? t('marketplace.contributing') : t('marketplace.contribute_btn')}
          </button>
        )}
      </div>

      {hasSample && (
        <div
          className="card"
          role="status"
          style={{ marginBottom: 16, background: 'var(--warning-bg)', borderColor: 'var(--warning)' }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>
            {t('marketplace.sample_banner_title')}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {t('marketplace.sample_banner_body')}
          </p>
        </div>
      )}

      <form className="card" style={{ marginBottom: 16 }} onSubmit={handleApply}>
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 16 }}>{t('marketplace.filters_title')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <FormField label={t('marketplace.filter_platform')} style={{ marginBottom: 0 }}>
            <select
              className="form-select"
              value={draft.platform}
              onChange={e => setDraft({ ...draft, platform: e.target.value })}
            >
              <option value="">{t('marketplace.filter_platform_all')}</option>
              {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FormField>

          <FormField label={t('marketplace.filter_category')} style={{ marginBottom: 0 }}>
            <select
              className="form-select"
              value={draft.category}
              onChange={e => setDraft({ ...draft, category: e.target.value })}
            >
              <option value="">{t('marketplace.filter_category_all')}</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>

          <FormField label={t('marketplace.filter_min_followers')} style={{ marginBottom: 0 }}>
            <input
              className="form-input"
              type="number"
              min="0"
              step="1000"
              value={draft.min_followers}
              onChange={e => setDraft({ ...draft, min_followers: e.target.value })}
            />
          </FormField>

          <FormField label={t('marketplace.filter_search')} style={{ marginBottom: 0 }}>
            <input
              className="form-input"
              type="search"
              placeholder={t('marketplace.filter_search_placeholder')}
              value={draft.q}
              onChange={e => setDraft({ ...draft, q: e.target.value })}
            />
          </FormField>

          <FormField label={t('marketplace.filter_sort')} style={{ marginBottom: 0 }}>
            <select
              className="form-select"
              value={draft.sort}
              onChange={e => setDraft({ ...draft, sort: e.target.value })}
            >
              <option value="followers">{t('marketplace.sort_followers')}</option>
              <option value="engagement">{t('marketplace.sort_engagement')}</option>
              <option value="recent">{t('marketplace.sort_recent')}</option>
            </select>
          </FormField>
        </div>
        <div className="btn-group" style={{ marginTop: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>{t('marketplace.apply')}</button>
          <button type="button" className="btn btn-secondary" onClick={handleReset} disabled={loading}>{t('marketplace.reset')}</button>
        </div>
      </form>

      {/* Error is its own branch: an ErrorCard with a retry, never a silent
          empty grid (the pattern PR #13 standardised). */}
      {loadError && <ErrorCard error={loadError} onRetry={load} />}

      {/* Loading is visually distinct from both error and empty. */}
      {loading && !loadError && (
        <div className="empty-state" aria-live="polite">
          <p>{t('marketplace.loading')}</p>
        </div>
      )}

      {showEmpty && (
        <div className="empty-state">
          <h4>{hasFilters ? t('marketplace.no_results_title') : t('marketplace.empty_title')}</h4>
          <p>{hasFilters ? t('marketplace.no_results_body') : t('marketplace.empty_body')}</p>
        </div>
      )}

      {!loading && !loadError && items.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            {t('marketplace.count_label', { shown: items.length, total })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {items.map(c => (
              <div className="card" key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {c.avatar_url
                    ? <img src={c.avatar_url} alt="" width="40" height="40" style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--bg-input)' }} />
                    : <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--bg-input)', flexShrink: 0 }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.display_name || c.username}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      @{c.username}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-purple">{c.platform}</span>
                  <span className="badge badge-gray">{c.category || t('marketplace.uncategorized')}</span>
                  {c.is_sample && <span className="badge badge-orange">{t('marketplace.sample_badge')}</span>}
                </div>

                <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t('marketplace.followers_label')}</div>
                    <div style={{ fontWeight: 600 }}>{formatFollowers(c.followers)}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t('marketplace.engagement_label')}</div>
                    <div style={{ fontWeight: 600 }}>{(Number(c.engagement_rate) || 0).toFixed(1)}%</div>
                  </div>
                </div>

                {/* Provenance, surfaced to the user: what kind of source this
                    listing came from and when it was listed. Never which
                    workspace contributed it — that is tenant-private. */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {c.is_sample ? t('marketplace.source_sample') : t('marketplace.source_public_profile')}
                  {c.listed_at && (
                    <> · {t('marketplace.listed_on', { date: new Date(c.listed_at).toLocaleDateString() })}</>
                  )}
                </div>

                <div className="btn-group" style={{ marginTop: 'auto' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleAdd(c)}
                    disabled={c.is_sample || addingId === c.id}
                    title={c.is_sample ? t('marketplace.add_sample_disabled') : t('marketplace.add_btn')}
                  >
                    {addingId === c.id ? t('marketplace.adding') : t('marketplace.add_btn')}
                  </button>
                  {c.profile_url && (
                    <a
                      className="btn btn-secondary btn-sm"
                      href={c.profile_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none' }}
                    >
                      {t('marketplace.view_profile')}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="btn-group" style={{ marginTop: 16, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
            >
              {t('marketplace.prev_page')}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + items.length >= total}
            >
              {t('marketplace.next_page')}
            </button>
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 20, maxWidth: 720 }}>
        {t('marketplace.privacy_note')}
      </p>
    </div>
  );
}
