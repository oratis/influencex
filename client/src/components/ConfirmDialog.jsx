import React, { useState, useCallback, useEffect, useRef, createContext, useContext } from 'react';
import { useI18n } from '../i18n';

const ConfirmContext = createContext();

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);

  const confirm = useCallback((message, { title, confirmText, cancelText, danger = false } = {}) => {
    return new Promise((resolve) => {
      setState({
        message,
        title: title || t('common.confirm'),
        confirmText: confirmText || t('common.confirm'),
        cancelText: cancelText || t('common.cancel'),
        danger,
        resolve,
      });
    });
  }, [t]);

  const prompt = useCallback((message, { title, placeholder = '', defaultValue = '', confirmText } = {}) => {
    return new Promise((resolve) => {
      setState({
        message,
        title: title || t('common.input'),
        confirmText: confirmText || t('common.ok'),
        cancelText: t('common.cancel'),
        resolve,
        isPrompt: true,
        placeholder,
        defaultValue,
      });
    });
  }, [t]);

  const handleClose = (result) => {
    state?.resolve(result);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}
      {state && <ConfirmModal state={state} onClose={handleClose} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmModal({ state, onClose }) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState(state.defaultValue || '');
  const previousFocusRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const inputRef = useRef(null);

  // Focus management (audit C-5):
  //   - On open: remember the element that triggered the modal, then focus
  //     the input (prompt) or the primary button (confirm).
  //   - On close: return focus to whatever was focused before so keyboard
  //     users don't lose their place.
  //   - ESC key closes the modal (matches design.md's modal contract).
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const target = state.isPrompt ? inputRef.current : confirmBtnRef.current;
    if (target && typeof target.focus === 'function') {
      // Defer one tick so the modal is in the DOM.
      setTimeout(() => target.focus(), 0);
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose(state.isPrompt ? null : false);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" onClick={() => onClose(state.isPrompt ? null : false)} style={{ zIndex: 2000 }} role="dialog" aria-modal="true">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
        <div className="modal-header">
          <h3>{state.title}</h3>
          <button className="btn-icon" onClick={() => onClose(state.isPrompt ? null : false)} aria-label={t('common.close')} title={t('common.close')}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: '14px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>{state.message}</p>
          {state.isPrompt && (
            <input
              ref={inputRef}
              className="form-input"
              placeholder={state.placeholder}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && inputValue.trim() && onClose(inputValue)}
              style={{ marginTop: '12px' }}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => onClose(state.isPrompt ? null : false)}>
            {state.cancelText}
          </button>
          <button
            ref={confirmBtnRef}
            className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onClose(state.isPrompt ? inputValue : true)}
            disabled={state.isPrompt && !inputValue.trim()}
          >
            {state.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
