import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The page fans out to six endpoints; stub the client so these tests are about
// the usage section's own states (empty / populated / failed), not the network.
vi.mock('../api/client', () => ({
  api: {
    getAgentAnalytics: vi.fn().mockResolvedValue({ byAgent: [] }),
    getPlatformAnalytics: vi.fn().mockResolvedValue({ byPlatform: [] }),
    getPresetAnalytics: vi.fn().mockResolvedValue({ presets: [] }),
    getContentAnalytics: vi.fn().mockResolvedValue({ byType: {} }),
    getAgentCostSummary: vi.fn().mockResolvedValue(null),
    getUsage: vi.fn(),
  },
  setApiTranslator: vi.fn(),
  toastApiError: vi.fn(),
}));

// recharts needs layout to render; the chart is lazy anyway, so stub the whole
// module. The table below it is the value-bearing view and stays real.
vi.mock('../components/UsageChart', () => ({
  default: () => <div data-testid="usage-chart" />,
}));

import { api } from '../api/client';
import { I18nProvider } from '../i18n';
import AnalyticsPage from './AnalyticsPage';

const EMPTY_USAGE = {
  workspace_id: 'ws-1',
  window: { months: 6, from: '2026-03-01 00:00:00', agent_id: null },
  truncated: false,
  months: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
  rows: [],
  byMonth: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']
    .map(month => ({ month, runs: 0, input_tokens: 0, output_tokens: 0, usd_cents: 0 })),
  byAgent: [],
  total: { runs: 0, input_tokens: 0, output_tokens: 0, usd_cents: 0 },
};

const POPULATED_USAGE = {
  ...EMPTY_USAGE,
  rows: [
    { month: '2026-07', agent_id: 'strategy', runs: 2, input_tokens: 1200, output_tokens: 300, usd_cents: 45 },
    { month: '2026-08', agent_id: 'strategy', runs: 3, input_tokens: 2000, output_tokens: 500, usd_cents: 120 },
    { month: '2026-08', agent_id: 'ads', runs: 1, input_tokens: 400, output_tokens: 90, usd_cents: 15 },
  ],
  byMonth: EMPTY_USAGE.byMonth.map(m =>
    m.month === '2026-07' ? { ...m, runs: 2, input_tokens: 1200, output_tokens: 300, usd_cents: 45 }
      : m.month === '2026-08' ? { ...m, runs: 4, input_tokens: 2400, output_tokens: 590, usd_cents: 135 }
        : m
  ),
  byAgent: [
    { agent_id: 'strategy', runs: 5, input_tokens: 3200, output_tokens: 800, usd_cents: 165 },
    { agent_id: 'ads', runs: 1, input_tokens: 400, output_tokens: 90, usd_cents: 15 },
  ],
  total: { runs: 6, input_tokens: 3600, output_tokens: 890, usd_cents: 180 },
};

const renderPage = () => render(<I18nProvider><AnalyticsPage /></I18nProvider>);

describe('AnalyticsPage usage ledger', () => {
  beforeEach(() => { api.getUsage.mockReset(); });

  it('shows an empty state, not a blank card, for a workspace with no runs', async () => {
    api.getUsage.mockResolvedValue(EMPTY_USAGE);
    renderPage();

    expect(await screen.findByText('No agent runs in this window.')).toBeInTheDocument();
    expect(screen.getByText(/widen the window/i)).toBeInTheDocument();
    // No table and no chart when there is nothing to plot.
    expect(screen.queryByTestId('usage-chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Input tokens' })).not.toBeInTheDocument();
  });

  it('renders the month × agent breakdown with a total row', async () => {
    api.getUsage.mockResolvedValue(POPULATED_USAGE);
    renderPage();

    expect(await screen.findByTestId('usage-chart')).toBeInTheDocument();
    // Months newest-first, each with a subtotal row then its agents.
    const monthCells = screen.getAllByText(/^2026-0[78]$/).map(el => el.textContent);
    expect(monthCells).toEqual(['2026-08', '2026-07']);
    // `selector: 'code'` scopes to the table cells — the agent names also
    // appear as <option>s in the filter dropdown.
    expect(screen.getAllByText('strategy', { selector: 'code' })).toHaveLength(2);
    expect(screen.getByText('ads', { selector: 'code' })).toBeInTheDocument();
    // Grand total: 180¢ formats as dollars, 3,600 input tokens.
    expect(screen.getByText('$1.80')).toBeInTheDocument();
    expect(screen.getByText('3,600')).toBeInTheDocument();
  });

  it('surfaces a load failure with a retry instead of an empty card', async () => {
    api.getUsage.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    const retry = await screen.findByRole('button', { name: /retry/i });
    api.getUsage.mockResolvedValue(POPULATED_USAGE);
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('usage-chart')).toBeInTheDocument());
  });

  it('flags a failed refetch instead of silently holding stale numbers', async () => {
    api.getUsage.mockResolvedValueOnce(POPULATED_USAGE).mockRejectedValueOnce(new Error('gone'));
    renderPage();
    await screen.findByTestId('usage-chart');

    await userEvent.selectOptions(screen.getByLabelText('Window'), '12');

    // The already-loaded table stays, but the failure is visible and retryable.
    await screen.findByRole('alert');
    expect(screen.getByTestId('usage-chart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('refetches when the window or agent filter changes', async () => {
    api.getUsage.mockResolvedValue(POPULATED_USAGE);
    renderPage();
    await screen.findByTestId('usage-chart');
    expect(api.getUsage).toHaveBeenCalledWith({ months: 6, agent: undefined });

    await userEvent.selectOptions(screen.getByLabelText('Window'), '12');
    await waitFor(() => expect(api.getUsage).toHaveBeenCalledWith({ months: 12, agent: undefined }));

    await userEvent.selectOptions(screen.getByLabelText('Agent'), 'ads');
    await waitFor(() => expect(api.getUsage).toHaveBeenCalledWith({ months: 12, agent: 'ads' }));
  });
});
