import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useAuth } from '../AuthContext';
import { api } from '../api/client';

// Cmd-K / Ctrl-K command palette. Lists every nav destination plus quick
// actions (logout, switch language). Filterable by typed query — fuzzy
// match on the visible label. Returns null while closed so it costs nothing.
export default function CommandPalette() {
  const { t, lang, setLang } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [searchHits, setSearchHits] = useState({ kols: [], contacts: [], campaigns: [] });
  const inputRef = useRef(null);
  const searchTimer = useRef(null);

  // Global hotkey listener.
  useEffect(() => {
    function handleKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(v => !v);
        setQuery('');
        setActiveIdx(0);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const isAdmin = user?.role === 'admin';

  const items = useMemo(() => {
    // Mirrors the sidebar nav, plus extra quick actions. Adding a new entry
    // here makes it discoverable via Cmd-K without touching anything else.
    const base = [
      { id: 'nav:conductor',   label: t('nav.conductor'),    kind: 'nav', path: '/conductor' },
      { id: 'nav:studio',      label: t('nav.studio'),       kind: 'nav', path: '/studio' },
      { id: 'nav:calendar',    label: t('nav.calendar'),     kind: 'nav', path: '/calendar' },
      { id: 'nav:connections', label: t('nav.connections'),  kind: 'nav', path: '/connections' },
      { id: 'nav:analytics',   label: t('nav.analytics'),    kind: 'nav', path: '/analytics' },
      { id: 'nav:inbox',       label: t('nav.community'),    kind: 'nav', path: '/inbox' },
      { id: 'nav:ads',         label: t('nav.ads'),          kind: 'nav', path: '/ads' },
      { id: 'nav:translate',   label: t('nav.translate'),    kind: 'nav', path: '/translate' },
      { id: 'nav:agents',      label: t('nav.agents'),       kind: 'nav', path: '/agents' },
      { id: 'nav:pipeline',    label: t('nav.pipeline'),     kind: 'nav', path: '/pipeline' },
      { id: 'nav:campaigns',   label: t('nav.campaigns'),    kind: 'nav', path: '/campaigns' },
      { id: 'nav:roi',         label: t('nav.roi'),          kind: 'nav', path: '/roi' },
      { id: 'nav:contacts',    label: t('nav.contacts'),     kind: 'nav', path: '/contacts' },
      { id: 'nav:data',        label: t('nav.data'),         kind: 'nav', path: '/data' },
      { id: 'nav:kol-database', label: t('nav.kol_database'), kind: 'nav', path: '/kol-database' },
      { id: 'nav:discovery',   label: t('nav.discovery'),    kind: 'nav', path: '/discovery' },
      { id: 'nav:reviews',     label: t('nav.reviews'),      kind: 'nav', path: '/reviews' },
      { id: 'nav:changelog',   label: t('nav.changelog'),    kind: 'nav', path: '/changelog' },
      { id: 'nav:users',       label: t('nav.users'),        kind: 'nav', path: '/users' },
      { id: 'nav:workspace',   label: t('nav.workspace_settings') || 'Workspace settings', kind: 'nav', path: '/workspace/settings' },
    ];
    if (isAdmin) {
      base.push(
        { id: 'nav:invite-codes', label: t('nav.invite_codes'), kind: 'nav', path: '/invite-codes' },
        { id: 'nav:apify-runs',   label: t('nav.apify_runs'),   kind: 'nav', path: '/apify-runs' },
      );
    }
    base.push(
      { id: 'action:lang-en', label: t('command.switch_to_en'), kind: 'action', run: () => setLang('en') },
      { id: 'action:lang-zh', label: t('command.switch_to_zh'), kind: 'action', run: () => setLang('zh') },
      { id: 'action:logout',  label: t('auth.sign_out'),         kind: 'action', run: () => logout() },
    );
    return base;
  }, [t, isAdmin, lang, setLang, logout]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => it.label.toLowerCase().includes(q));
  }, [items, query]);

  // Keep activeIdx in range as the filter changes.
  useEffect(() => { setActiveIdx(0); }, [query]);

  // Debounced cross-entity search. Only kicks in when the user has typed
  // something — otherwise the palette stays a pure nav menu.
  useEffect(() => {
    if (!open) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) { setSearchHits({ kols: [], contacts: [], campaigns: [] }); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await api.search(q);
        setSearchHits({ kols: r.kols || [], contacts: r.contacts || [], campaigns: r.campaigns || [] });
      } catch {
        setSearchHits({ kols: [], contacts: [], campaigns: [] });
      }
    }, 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, open]);

  // Append cross-entity search hits to the filtered nav results so they all
  // share keyboard navigation. Each hit gets a kind tag for clarity.
  const allItems = useMemo(() => {
    const list = [...filtered];
    for (const k of searchHits.kols) {
      list.push({
        id: `search:kol:${k.id}`,
        kind: 'kol',
        label: `${k.display_name || k.username} · ${k.platform} · ${Number(k.followers || 0).toLocaleString()}`,
        path: '/kol-database',
      });
    }
    for (const c of searchHits.contacts) {
      list.push({
        id: `search:contact:${c.id}`,
        kind: 'contact',
        label: `${c.kol_username || c.kol_email || 'contact'} · ${c.status || 'pending'}`,
        path: '/contacts',
      });
    }
    for (const cam of searchHits.campaigns) {
      list.push({
        id: `search:campaign:${cam.id}`,
        kind: 'campaign',
        label: `${cam.name} · ${cam.status || ''}`,
        path: `/campaigns/${cam.id}`,
      });
    }
    return list;
  }, [filtered, searchHits]);

  function pick(item) {
    if (!item) return;
    setOpen(false);
    if (item.kind === 'nav') {
      navigate(item.path);
    } else if (item.kind === 'action' && typeof item.run === 'function') {
      item.run();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(allItems[activeIdx]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => setOpen(false)}
      style={{ zIndex: 2500, alignItems: 'flex-start', paddingTop: '15vh' }}
    >
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 560, width: '90%', padding: 0, overflow: 'hidden' }}
      >
        <input
          ref={inputRef}
          className="form-input"
          type="text"
          placeholder={t('command.placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ borderRadius: 0, borderTop: 'none', borderLeft: 'none', borderRight: 'none', fontSize: 15, padding: 14 }}
        />
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {allItems.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {t('command.no_results')}
            </div>
          )}
          {allItems.map((it, idx) => (
            <button
              key={it.id}
              onClick={() => pick(it)}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                width: '100%',
                background: idx === activeIdx ? 'var(--accent-light)' : 'transparent',
                color: 'var(--text-primary)',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 13,
              }}
            >
              <span style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                background: 'var(--bg-card)',
                padding: '2px 6px',
                borderRadius: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}>
                {it.kind === 'nav' ? t('command.tag_go')
                  : it.kind === 'action' ? t('command.tag_action')
                  : it.kind === 'kol' ? t('command.tag_kol')
                  : it.kind === 'contact' ? t('command.tag_contact')
                  : it.kind === 'campaign' ? t('command.tag_campaign')
                  : '?'}
              </span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border, transparent)', fontSize: 11, color: 'var(--text-muted)' }}>
          {t('command.footer_hint')}
        </div>
      </div>
    </div>
  );
}
