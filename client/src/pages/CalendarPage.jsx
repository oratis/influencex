import React, { useEffect, useMemo, useState } from 'react';
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

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return d.toISOString().slice(0, 10); }

const STATUS_COLORS = {
  pending: '#f59e0b',
  running: '#3b82f6',
  complete: '#22c55e',
  error: '#ef4444',
  cancelled: '#6b7280',
};

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const { t, lang } = useI18n();

  const reload = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`${BASE}/scheduled-publishes?limit=500`, { headers: authHeaders() }).then(r => r.json());
      setItems(r.items || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const monthStart = startOfMonth(cursor);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const gridStart = addDays(monthStart, -monthStart.getDay()); // back to Sunday
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  const byDay = useMemo(() => {
    const map = {};
    for (const it of items) {
      if (!it.scheduled_at) continue;
      const k = ymd(new Date(it.scheduled_at));
      (map[k] ||= []).push(it);
    }
    return map;
  }, [items]);

  const monthLabel = monthStart.toLocaleString(lang === 'zh' ? 'zh-CN' : 'default', { month: 'long', year: 'numeric' });
  const weekdayKeys = ['weekday_sun', 'weekday_mon', 'weekday_tue', 'weekday_wed', 'weekday_thu', 'weekday_fri', 'weekday_sat'];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>📅 {t('calendar.title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))} style={btnStyle}>‹</button>
          <div style={{ minWidth: 170, textAlign: 'center', fontWeight: 600 }}>{monthLabel}</div>
          <button onClick={() => setCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))} style={btnStyle}>›</button>
          <button onClick={() => setCursor(startOfMonth(new Date()))} style={{ ...btnStyle, marginLeft: 8 }}>{t('calendar.today')}</button>
          <button onClick={reload} style={{ ...btnStyle, marginLeft: 8 }}>↻</button>
        </div>
      </div>

      {error && <div style={{ padding: 10, background: '#2a0f0f', color: '#ef4444', borderRadius: 8, marginBottom: 12 }}>{error}</div>}
      {loading && <div style={{ color: '#888', marginBottom: 12 }}>{t('common.loading')}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: '#1a1a25', borderRadius: 8, overflow: 'hidden' }}>
        {weekdayKeys.map(k => (
          <div key={k} style={{ padding: 8, background: '#0f0f18', color: '#888', fontSize: 12, textAlign: 'center', fontWeight: 600 }}>{t(`calendar.${k}`)}</div>
        ))}
        {days.map((d, i) => {
          const inMonth = d.getMonth() === monthStart.getMonth();
          const isToday = ymd(d) === ymd(new Date());
          const dayItems = byDay[ymd(d)] || [];
          return (
            <div key={i} style={{
              minHeight: 100, padding: 6, background: '#0a0a14',
              opacity: inMonth ? 1 : 0.4,
              borderLeft: isToday ? '3px solid #8b5cf6' : '3px solid transparent',
            }}>
              <div style={{ fontSize: 12, color: isToday ? '#a78bfa' : '#bbb', fontWeight: isToday ? 700 : 400, marginBottom: 4 }}>
                {d.getDate()}
              </div>
              {dayItems.slice(0, 4).map(it => (
                <div key={it.id}
                  onClick={() => setSelected(it)}
                  title={(it.content_snapshot?.title || it.content_snapshot?.body || '').slice(0, 80)}
                  style={{
                    fontSize: 10, padding: '2px 6px', marginBottom: 2,
                    background: '#1a1a25', borderLeft: `3px solid ${STATUS_COLORS[it.status] || '#888'}`,
                    borderRadius: 3, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                  {new Date(it.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                  {(it.content_snapshot?.title || it.content_snapshot?.body || t('calendar.no_title')).slice(0, 26)}
                </div>
              ))}
              {dayItems.length > 4 && <div style={{ fontSize: 10, color: '#666' }}>{t('calendar.more', { count: dayItems.length - 4 })}</div>}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: '#888', display: 'flex', gap: 16 }}>
        {Object.entries(STATUS_COLORS).map(([s, c]) => (
          <span key={s}><span style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />{t(`calendar.status_${s}`)}</span>
        ))}
      </div>

      {selected && (
        <div onClick={() => setSelected(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#0f0f18', border: '1px solid #2a2a35', borderRadius: 12,
            padding: 24, maxWidth: 560, width: '90%', maxHeight: '80vh', overflow: 'auto',
          }}>
            <h3 style={{ marginTop: 0 }}>{selected.content_snapshot?.title || t('calendar.no_title')}</h3>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              {new Date(selected.scheduled_at).toLocaleString()} · <span style={{ color: STATUS_COLORS[selected.status] }}>{t(`calendar.status_${selected.status}`)}</span> · {(selected.platforms || []).join(', ')}
            </div>
            <div style={{ fontSize: 14, color: '#ddd', whiteSpace: 'pre-wrap', padding: 12, background: '#0a0a14', borderRadius: 8 }}>
              {selected.content_snapshot?.body || t('calendar.no_body')}
            </div>
            {selected.result && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: '#888' }}>{t('calendar.result')}</summary>
                <pre style={{ fontSize: 11, color: '#888', overflow: 'auto' }}>{JSON.stringify(selected.result, null, 2)}</pre>
              </details>
            )}
            <button onClick={() => setSelected(null)} style={{ marginTop: 16, ...btnStyle }}>{t('calendar.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  padding: '6px 12px', background: '#1a1a25', color: '#fff',
  border: '1px solid #2a2a35', borderRadius: 6, cursor: 'pointer',
};
