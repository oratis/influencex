import React, { useState, useCallback, useRef, createContext, useContext } from 'react';
import { useI18n } from '../i18n';
import Modal from './Modal';

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
  const confirmBtnRef = useRef(null);
  const inputRef = useRef(null);

  // Focus capture/restore, ESC and the focus trap all live in <Modal> now
  // (see components/Modal.jsx). This component only picks the initial focus
  // target: the input for a prompt, the primary button for a confirm.
  const dismiss = () => onClose(state.isPrompt ? null : false);

  return (
    <Modal
      onClose={dismiss}
      labelledBy="confirm-dialog-title"
      initialFocusRef={state.isPrompt ? inputRef : confirmBtnRef}
      overlayStyle={{ zIndex: 2000 }}
      style={{ maxWidth: '440px' }}
    >
        <div className="modal-header">
          <h3 id="confirm-dialog-title">{state.title}</h3>
          <button className="btn-icon" onClick={dismiss} aria-label={t('common.close')} title={t('common.close')}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: '14px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>{state.message}</p>
          {state.isPrompt && (
            <input
              ref={inputRef}
              className="form-input"
              aria-label={state.title}
              placeholder={state.placeholder}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && inputValue.trim() && onClose(inputValue)}
              style={{ marginTop: '12px' }}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={dismiss}>
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
    </Modal>
  );
}
