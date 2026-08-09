import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { ymdLocal } from '../utils/datetime';
import Modal from '../components/Modal';
import ErrorCard from '../components/ErrorCard';

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
// Bucket by LOCAL date parts — toISOString() is UTC and shifts events before
// 08:00 local (for UTC+8) onto the previous day, and breaks isToday.
const ymd = ymdLocal;

// design.md §0: no hex literals in .jsx — these map onto the shared status
// tokens declared in index.css :root.
const STATUS_COLORS = {
  pending: 'var(--warning)',
  running: 'var(--info)',
  complete: 'var(--success)',
  error: 'var(--danger)',
  cancelled: 'var(--text-muted)',
};

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const { t, lang } = useI18n();

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/scheduled-publishes?limit=500`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      setItems(r.items || []);
    } catch (e) { setError(e); }
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const monthStart = startOfMonth(cursor);
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
        <h1 style={{ fontSize: 24, margin: 0 }}><span aria-hidden="true">📅</span> {t('calendar.title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))}
            style={btnStyle}
            aria-label={t('calendar.prev_month')}
            title={t('calendar.prev_month')}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <div style={{ minWidth: 170, textAlign: 'center', fontWeight: 600 }}>{monthLabel}</div>
          <button
            onClick={() => setCursor(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))}
            style={btnStyle}
            aria-label={t('calendar.next_month')}
            title={t('calendar.next_month')}
          >
            <span aria-hidden="true">›</span>
          </button>
          <button onClick={() => setCursor(startOfMonth(new Date()))} style={{ ...btnStyle, marginLeft: 8 }}>{t('calendar.today')}</button>
          <button
            onClick={reload}
            style={{ ...btnStyle, marginLeft: 8 }}
            aria-label={t('common.retry')}
            title={t('common.retry')}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </div>

      {error && <ErrorCard error={error} onRetry={reload} compact />}
      {loading && <div style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>{t('common.loading')}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: 'var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {weekdayKeys.map(k => (
          <div key={k} style={{ padding: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', fontWeight: 600 }}>{t(`calendar.${k}`)}</div>
        ))}
        {days.map((d, i) => {
          const inMonth = d.getMonth() === monthStart.getMonth();
          const isToday = ymd(d) === ymd(new Date());
          const dayItems = byDay[ymd(d)] || [];
          return (
            <div key={i} style={{
              minHeight: 100, padding: 6, background: 'var(--bg-primary)',
              opacity: inMonth ? 1 : 0.4,
              borderLeft: isToday ? '3px solid var(--accent)' : '3px solid transparent',
            }}>
              <div style={{ fontSize: 12, color: isToday ? 'var(--accent-hover)' : 'var(--text-secondary)', fontWeight: isToday ? 700 : 400, marginBottom: 4 }}>
                {d.getDate()}
              </div>
              {dayItems.slice(0, 4).map(it => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setSelected(it)}
                  title={(it.content_snapshot?.title || it.content_snapshot?.body || '').slice(0, 80)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', font: 'inherit',
                    fontSize: 10, padding: '2px 6px', marginBottom: 2,
                    color: 'var(--text-primary)',
                    background: 'var(--bg-card)', borderLeft: `3px solid ${STATUS_COLORS[it.status] || 'var(--text-muted)'}`,
                    borderTop: 0, borderRight: 0, borderBottom: 0,
                    borderRadius: 3, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                  {new Date(it.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                  {(it.content_snapshot?.title || it.content_snapshot?.body || t('calendar.no_title')).slice(0, 26)}
                </button>
              ))}
              {dayItems.length > 4 && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('calendar.more', { count: dayItems.length - 4 })}</div>}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 16 }}>
        {Object.entries(STATUS_COLORS).map(([s, c]) => (
          <span key={s}><span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />{t(`calendar.status_${s}`)}</span>
        ))}
      </div>

      {selected && (
        <Modal
          onClose={() => setSelected(null)}
          labelledBy="calendar-detail-title"
          overlayClassName=""
          overlayStyle={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          }}
          className=""
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: 24, maxWidth: 560, width: '90%', maxHeight: '80vh', overflow: 'auto',
          }}
        >
            <h3 id="calendar-detail-title" style={{ marginTop: 0 }}>{selected.content_snapshot?.title || t('calendar.no_title')}</h3>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {new Date(selected.scheduled_at).toLocaleString()} · <span style={{ color: STATUS_COLORS[selected.status] }}>{t(`calendar.status_${selected.status}`)}</span> · {(selected.platforms || []).join(', ')}
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', padding: 12, background: 'var(--bg-input)', borderRadius: 8 }}>
              {selected.content_snapshot?.body || t('calendar.no_body')}
            </div>
            {selected.result && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>{t('calendar.result')}</summary>
                <pre style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'auto' }}>{JSON.stringify(selected.result, null, 2)}</pre>
              </details>
            )}
            <button onClick={() => setSelected(null)} style={{ marginTop: 16, ...btnStyle }}>{t('calendar.close')}</button>
        </Modal>
      )}
    </div>
  );
}

const btnStyle = {
  padding: '6px 12px', background: 'var(--bg-card)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
};
