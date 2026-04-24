import React from 'react';

// Catches render-time exceptions in children. Falls back to a simple card
// with reload + optional reset. Keep this a class component — hooks can't
// implement componentDidCatch.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (typeof window !== 'undefined' && window.console) {
      console.error('[ErrorBoundary] caught:', error, info?.componentStack);
    }
  }

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleReset = () => {
    this.setState({ error: null });
    if (typeof this.props.onReset === 'function') this.props.onReset();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const fallback = this.props.fallback;
    if (typeof fallback === 'function') {
      return fallback({ error: this.state.error, reset: this.handleReset, reload: this.handleReload });
    }

    const t = this.props.t || ((_k, fb) => fb);
    return (
      <div className="error-boundary-fallback" role="alert">
        <div className="error-card" style={{ maxWidth: 520, margin: '80px auto', padding: 24, border: '1px solid var(--border, #e5e7eb)', borderRadius: 12, background: 'var(--surface, #fff)' }}>
          <h2 style={{ margin: 0, marginBottom: 8, fontSize: 20 }}>
            {t('common.error_title', 'Something went wrong')}
          </h2>
          <p style={{ margin: 0, marginBottom: 16, color: 'var(--text-muted, #6b7280)' }}>
            {t('common.error_body', 'The page ran into an unexpected error. You can try reloading or go back and try again.')}
          </p>
          {this.state.error?.message && (
            <pre style={{ background: 'var(--muted, #f3f4f6)', padding: 8, borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 120, margin: 0, marginBottom: 16 }}>
              {String(this.state.error.message)}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={this.handleReload}>
              {t('common.error_reload', 'Reload page')}
            </button>
            <button className="btn" onClick={this.handleReset}>
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
