import React, { useState, useCallback, createContext, useContext } from 'react';

const ConfirmContext = createContext();

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);

  const confirm = useCallback((message, { title = 'Confirm', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) => {
    return new Promise((resolve) => {
      setState({ message, title, confirmText, cancelText, danger, resolve });
    });
  }, []);

  const prompt = useCallback((message, { title = 'Input', placeholder = '', defaultValue = '', confirmText = 'OK' } = {}) => {
    return new Promise((resolve) => {
      setState({ message, title, confirmText, cancelText: 'Cancel', resolve, isPrompt: true, placeholder, defaultValue });
    });
  }, []);

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
  const [inputValue, setInputValue] = useState(state.defaultValue || '');

  return (
    <div className="modal-overlay" onClick={() => onClose(state.isPrompt ? null : false)} style={{ zIndex: 2000 }}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
        <div className="modal-header">
          <h3>{state.title}</h3>
          <button className="btn-icon" onClick={() => onClose(state.isPrompt ? null : false)}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: '14px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>{state.message}</p>
          {state.isPrompt && (
            <input
              className="form-input"
              placeholder={state.placeholder}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              autoFocus
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
