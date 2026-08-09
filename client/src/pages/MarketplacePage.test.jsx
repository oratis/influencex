import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The page pulls in the API client, toast, auth and campaign contexts. Stub
// them so the test focuses on the three states that must never be confused
// with one another — loading, empty, and error — plus the sample-data banner.
vi.mock('../api/client', () => ({
  api: {
    getMarketplaceCreators: vi.fn(),
    addMarketplaceCreatorToCampaign: vi.fn(),
    contributeToMarketplace: vi.fn(),
  },
  setApiTranslator: vi.fn(),
  toastApiError: vi.fn(),
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Tester', role: 'editor' } }),
}));

vi.mock('../CampaignContext', () => ({
  useCampaign: () => ({ selectedCampaignId: 'camp-1', selectedCampaign: { id: 'camp-1', name: 'Q1 push' } }),
}));

import { api } from '../api/client';
import { I18nProvider } from '../i18n';
import MarketplacePage from './MarketplacePage';

const EMPTY_RESPONSE = { items: [], total: 0, limit: 24, offset: 0, categories: [], has_sample: false };

const SAMPLE_ROW = {
  id: 'sample-1',
  platform: 'youtube',
  username: 'sample-creator-a',
  display_name: 'Sample Creator A',
  avatar_url: 'https://example.com/avatars/sample-creator-a.png',
  profile_url: 'https://example.com/youtube/sample-creator-a',
  followers: 128000,
  engagement_rate: 4.2,
  category: 'gaming',
  source: 'sample',
  listed_at: '2026-08-10T00:00:00Z',
  is_sample: true,
};

const REAL_ROW = {
  ...SAMPLE_ROW,
  id: 'real-1',
  username: 'realcreator',
  display_name: 'Real Creator',
  profile_url: 'https://www.youtube.com/@realcreator',
  source: 'public_profile',
  is_sample: false,
};

function renderPage() {
  return render(<I18nProvider><MarketplacePage /></I18nProvider>);
}

beforeEach(() => {
  api.getMarketplaceCreators.mockReset();
  api.addMarketplaceCreatorToCampaign.mockReset();
});

describe('MarketplacePage', () => {
  it('shows a loading state that is not the empty state', async () => {
    let resolve;
    api.getMarketplaceCreators.mockReturnValue(new Promise(r => { resolve = r; }));
    renderPage();

    expect(screen.getByText(/loading creators/i)).toBeInTheDocument();
    expect(screen.queryByText(/no creators in the catalog yet/i)).not.toBeInTheDocument();

    resolve(EMPTY_RESPONSE);
    await waitFor(() => expect(screen.queryByText(/loading creators/i)).not.toBeInTheDocument());
  });

  it('shows the empty state — not an error — when the catalog is empty', async () => {
    api.getMarketplaceCreators.mockResolvedValue(EMPTY_RESPONSE);
    renderPage();

    await screen.findByText(/no creators in the catalog yet/i);
    // The empty state must be distinguishable from the error state: no alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('distinguishes "no results for these filters" from "catalog is empty"', async () => {
    api.getMarketplaceCreators.mockResolvedValue(EMPTY_RESPONSE);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/no creators in the catalog yet/i);

    await user.type(screen.getByLabelText(/^search$/i), 'nobody');
    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    await screen.findByText(/no creators match these filters/i);
    expect(screen.queryByText(/no creators in the catalog yet/i)).not.toBeInTheDocument();
  });

  it('renders an ErrorCard with a working retry when the load fails', async () => {
    api.getMarketplaceCreators.mockRejectedValueOnce(new Error('Catalog unavailable'));
    const user = userEvent.setup();
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Catalog unavailable/);

    api.getMarketplaceCreators.mockResolvedValue({ ...EMPTY_RESPONSE, items: [REAL_ROW], total: 1 });
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByText('Real Creator');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('banners sample data and refuses to add a sample row to a campaign', async () => {
    api.getMarketplaceCreators.mockResolvedValue({
      ...EMPTY_RESPONSE,
      items: [SAMPLE_ROW, REAL_ROW],
      total: 2,
      has_sample: true,
      categories: ['gaming'],
    });
    renderPage();

    await screen.findByText('Sample Creator A');
    expect(screen.getByText(/this catalog contains sample data/i)).toBeInTheDocument();
    expect(screen.getByText(/^Sample$/)).toBeInTheDocument();

    // The sample card's add button is disabled; the real one's is not.
    const addButtons = screen.getAllByRole('button', { name: /add to campaign/i });
    expect(addButtons).toHaveLength(2);
    expect(addButtons[0]).toBeDisabled();
    expect(addButtons[1]).toBeEnabled();
  });

  it('does not banner sample data when the catalog has none', async () => {
    api.getMarketplaceCreators.mockResolvedValue({ ...EMPTY_RESPONSE, items: [REAL_ROW], total: 1 });
    renderPage();

    await screen.findByText('Real Creator');
    expect(screen.queryByText(/this catalog contains sample data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Sample$/)).not.toBeInTheDocument();
  });

  it('adds a real creator to the active campaign', async () => {
    api.getMarketplaceCreators.mockResolvedValue({ ...EMPTY_RESPONSE, items: [REAL_ROW], total: 1 });
    api.addMarketplaceCreatorToCampaign.mockResolvedValue({ id: 'kol-1' });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Real Creator');
    await user.click(screen.getByRole('button', { name: /add to campaign/i }));

    await waitFor(() =>
      expect(api.addMarketplaceCreatorToCampaign).toHaveBeenCalledWith('real-1', 'camp-1')
    );
  });

  it('never renders contact data on a creator card — the API has none to give', async () => {
    // Even if a server regression started returning private fields, the card
    // must not surface them: it renders a fixed set of public attributes.
    api.getMarketplaceCreators.mockResolvedValue({
      ...EMPTY_RESPONSE,
      total: 1,
      items: [{ ...REAL_ROW, email: 'creator@example.org', contact_info: '{"phone":"+1 555 0100"}', ai_score: 92 }],
    });
    const { container } = renderPage();

    const card = (await screen.findByText('Real Creator')).closest('.card');
    expect(card).toBeTruthy();
    expect(card.textContent).not.toMatch(/creator@example\.org/);
    expect(card.textContent).not.toMatch(/555 0100/);
    expect(card.textContent).not.toMatch(/\bemail\b/i);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
