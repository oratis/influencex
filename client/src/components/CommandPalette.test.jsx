import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import { I18nProvider } from '../i18n';
import { AuthContext } from '../AuthContext';

function wrap(ui, { user = { role: 'editor', email: 'x@y.z' } } = {}) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <AuthContext.Provider value={{ user, login: () => {}, logout: () => {}, setSessionFromApi: () => {} }}>
          {ui}
        </AuthContext.Provider>
      </I18nProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Stub fetch so the cross-entity search useEffect doesn't fire real requests.
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ kols: [], contacts: [], campaigns: [] }) }));
});

describe('CommandPalette', () => {
  it('is closed by default (no input visible)', () => {
    wrap(<CommandPalette />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('opens on Cmd-K, closes on Esc', async () => {
    wrap(<CommandPalette />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('also opens on Ctrl-K (Windows / Linux)', () => {
    wrap(<CommandPalette />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows admin-only nav entries when role=admin', () => {
    wrap(<CommandPalette />, { user: { role: 'admin', email: 'a@b' } });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })));
    // Invite Codes + Apify Runs should be present
    expect(screen.getByText(/invite codes/i)).toBeInTheDocument();
    expect(screen.getByText(/apify runs/i)).toBeInTheDocument();
  });

  it('hides admin-only entries for non-admin users', () => {
    wrap(<CommandPalette />, { user: { role: 'editor', email: 'a@b' } });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })));
    expect(screen.queryByText(/invite codes/i)).toBeNull();
    expect(screen.queryByText(/apify runs/i)).toBeNull();
  });

  it('filters items as the user types', async () => {
    const user = userEvent.setup();
    wrap(<CommandPalette />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })));
    const input = screen.getByRole('textbox');
    await user.type(input, 'pipeline');
    // "Pipeline" still visible
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    // "Studio" no longer in the filtered list
    expect(screen.queryByText('Content Studio')).toBeNull();
  });
});
