import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ToastProvider, useToast } from './Toast';

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.success('saved ok')}>fire-success</button>
      <button onClick={() => toast.error('boom')}>fire-error</button>
    </>
  );
}

describe('ToastProvider', () => {
  it('renders toasts inside a polite live region (role=status)', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByText('fire-success'));
    expect(region.textContent).toContain('saved ok');
  });

  it('exposes working success/error helpers (useMemo object, not useCallback)', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText('fire-error'));
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
