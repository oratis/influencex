import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import OnboardingTour from './OnboardingTour';
import { I18nProvider } from '../i18n';
import { CampaignContext } from '../CampaignContext';

const STORAGE_KEY = 'influencex_onboarding_done_v1';

function wrap(ui, { campaigns = [], loading = false } = {}) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <CampaignContext.Provider value={{ campaigns, loading, selectedCampaignId: null, selectedCampaign: null, selectCampaign: () => {}, refreshCampaigns: () => {} }}>
          {ui}
        </CampaignContext.Provider>
      </I18nProvider>
    </MemoryRouter>
  );
}

describe('OnboardingTour', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('does NOT auto-show when localStorage flag is set', async () => {
    localStorage.setItem(STORAGE_KEY, '1');
    wrap(<OnboardingTour />, { campaigns: [] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does NOT auto-show when the workspace already has campaigns', async () => {
    wrap(<OnboardingTour />, { campaigns: [{ id: '1', name: 'X' }] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('auto-shows after the deferred timeout for first-time users with no campaigns', async () => {
    wrap(<OnboardingTour />, { campaigns: [] });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('manual restart event force-opens even when campaigns exist', async () => {
    wrap(<OnboardingTour />, { campaigns: [{ id: '1', name: 'X' }] });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByRole('dialog')).toBeNull(); // not auto-shown
    act(() => window.dispatchEvent(new Event('onboarding:restart')));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Skip dismisses + persists the localStorage flag', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    wrap(<OnboardingTour />, { campaigns: [] });
    await new Promise(r => setTimeout(r, 900));
    const skip = screen.getByRole('button', { name: /skip/i });
    await user.click(skip);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
  });
});
