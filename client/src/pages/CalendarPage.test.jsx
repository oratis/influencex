import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n';
import CalendarPage from './CalendarPage';

beforeEach(() => {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    json: async () => ({ items: [{ id: 's1', scheduled_at: new Date().toISOString(), status: 'pending', platforms: ['twitter'], content_snapshot: { title: 'Hello', body: 'Body' } }] }),
  }));
});

// Covers two of this batch's changes at once: the day-cell events became real
// buttons (were click-only <div>s) and the detail popup now goes through the
// shared <Modal> primitive; a failed load renders an ErrorCard instead of an
// empty month.
describe('CalendarPage', () => {
  it('renders events as buttons and opens an accessible detail dialog', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><CalendarPage /></I18nProvider>);
    const evt = await screen.findByRole('button', { name: /Hello/ });
    await user.click(evt);
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveAccessibleName('Hello');
  });

  it('shows an ErrorCard with retry when the fetch fails', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    render(<I18nProvider><CalendarPage /></I18nProvider>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/500/);
  });
});
