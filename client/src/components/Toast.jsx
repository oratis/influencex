import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';

const ToastContext = createContext();

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    }
  }, []);

  const toast = useCallback({
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur ?? 6000),
    info: (msg, dur) => addToast(msg, 'info', dur),
    warning: (msg, dur) => addToast(msg, 'warning', dur),
  }, [addToast]);

  // Make toast callable directly: toast.success(), toast.error() etc
  const value = toast;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div style={{
        position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999,
        display: 'flex', flexDirection: 'column-reverse', gap: '8px', maxWidth: '400px',
      }}>
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={() => setToasts(prev => prev.filter(x => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_STYLES = {
  success: { bg: 'rgba(0,210,160,0.15)', border: 'rgba(0,210,160,0.3)', color: '#00d2a0', icon: '✓' },
  error: { bg: 'rgba(255,107,107,0.15)', border: 'rgba(255,107,107,0.3)', color: '#ff6b6b', icon: '✕' },
  warning: { bg: 'rgba(253,203,110,0.15)', border: 'rgba(253,203,110,0.3)', color: '#fdcb6e', icon: '!' },
  info: { bg: 'rgba(116,185,255,0.15)', border: 'rgba(116,185,255,0.3)', color: '#74b9ff', icon: 'i' },
};

function ToastItem({ toast, onDismiss }) {
  const s = TOAST_STYLES[toast.type] || TOAST_STYLES.info;
  return (
    <div
      onClick={onDismiss}
      style={{
        background: 'var(--bg-secondary)', border: `1px solid ${s.border}`,
        borderLeft: `3px solid ${s.color}`, borderRadius: '8px',
        padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: '10px',
        cursor: 'pointer', animation: 'fadeIn 0.2s ease', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        fontSize: '13px', color: 'var(--text-primary)', lineHeight: '1.4',
      }}
    >
      <span style={{
        width: '20px', height: '20px', borderRadius: '50%', background: s.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '11px', fontWeight: '700', color: s.color, flexShrink: 0,
      }}>
        {s.icon}
      </span>
      <span style={{ flex: 1 }}>{toast.message}</span>
    </div>
  );
}
