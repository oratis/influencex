import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The page pulls in the real API client + toast context; stub both so the
// test focuses on the bulk-selection a11y contract. `vi.mock` factories are
// hoisted, so the shared spies have to be created inside them.
vi.mock('../api/client', () => ({
  api: {
    getCampaign: vi.fn().mockResolvedValue({ id: 'c1', name: 'Q1 push', status: 'active', platforms: ['youtube'] }),
    getKols: vi.fn().mockResolvedValue([
      { id: 'k1', username: 'alpha', display_name: 'Alpha', platform: 'youtube', followers: 1000, engagement_rate: 4, avg_views: 500, category: 'gaming', ai_score: 90, status: 'pending' },
      { id: 'k2', username: 'beta', display_name: 'Beta', platform: 'youtube', followers: 2000, engagement_rate: 6, avg_views: 900, category: 'tech', ai_score: 70, status: 'pending' },
    ]),
    collectKols: vi.fn(),
    updateKol: vi.fn().mockResolvedValue({}),
    batchUpdateKols: vi.fn().mockResolvedValue({}),
  },
  setApiTranslator: vi.fn(),
  toastApiError: vi.fn(),
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import { api } from '../api/client';
import { I18nProvider } from '../i18n';
import CampaignDetail from './CampaignDetail';

const { updateKol, batchUpdateKols } = api;

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/campaigns/c1']}>
        <Routes>
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe('CampaignDetail bulk selection a11y', () => {
  beforeEach(() => {
    updateKol.mockClear();
    batchUpdateKols.mockClear();
  });

  it('renders real, named checkboxes instead of styled divs', async () => {
    renderPage();
    await screen.findByText('Alpha');

    // One "select all" + one per row.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: /select all/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /select alpha/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /select beta/i })).toBeInTheDocument();
  });

  it('can be selected with the keyboard and drives the bulk action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Alpha');

    const alpha = screen.getByRole('checkbox', { name: /select alpha/i });
    alpha.focus();
    expect(alpha).toHaveFocus();

    // Space toggles a native checkbox — the old <div> ignored it entirely.
    await user.keyboard(' ');
    expect(alpha).toBeChecked();

    // Exact name — the per-row icon buttons are "Approve <name>".
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await user.click(approve);
    await waitFor(() => expect(batchUpdateKols).toHaveBeenCalledWith(['k1'], 'approved'));
  });

  it('select-all checks every row and unchecks them again', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Alpha');

    const all = screen.getByRole('checkbox', { name: /select all/i });
    await user.click(all);
    expect(screen.getByRole('checkbox', { name: /select alpha/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select beta/i })).toBeChecked();
    expect(all).toBeChecked();

    await user.click(all);
    expect(screen.getByRole('checkbox', { name: /select alpha/i })).not.toBeChecked();
  });

  it('gives the per-row approve / reject icon buttons accessible names', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Alpha');

    const approveAlpha = screen.getByRole('button', { name: /approve alpha/i });
    expect(screen.getByRole('button', { name: /reject alpha/i })).toBeInTheDocument();

    await user.click(approveAlpha);
    await waitFor(() => expect(updateKol).toHaveBeenCalledWith('k1', { status: 'approved' }));
  });
});
