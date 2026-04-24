import React from 'react';
import { useI18n } from '../i18n';

// Inline error state for pages / sections. Use when an API call fails and
// you want to offer the user a retry rather than leaving them with a spinner
// or blank region.
export default function ErrorCard({ error, onRetry, title, body, compact }) {
  const { t } = useI18n();
  const message = error?.message || error || null;
  const resolvedTitle = title || t('common.error_load_failed');
  const resolvedBody = body;

  return (
    <div
      className={`error-card ${compact ? 'error-card-compact' : ''}`}
      role="alert"
      style={{
        margin: compact ? '12px 0' : '24px auto',
        maxWidth: compact ? 'none' : 520,
        padding: compact ? 12 : 20,
        border: '1px solid var(--border, #e5e7eb)',
        borderRadius: 10,
        background: 'var(--surface, #fff)',
      }}
    >
      <div style={{ fontSize: compact ? 14 : 16, fontWeight: 600, marginBottom: 6 }}>
        {resolvedTitle}
      </div>
      {resolvedBody && (
        <p style={{ margin: 0, marginBottom: 12, color: 'var(--text-muted, #6b7280)', fontSize: 14 }}>
          {resolvedBody}
        </p>
      )}
      {message && (
        <pre style={{ background: 'var(--muted, #f3f4f6)', padding: 8, borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 120, margin: 0, marginBottom: 12 }}>
          {String(message)}
        </pre>
      )}
      {typeof onRetry === 'function' && (
        <button className="btn btn-primary" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
