import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import type { Account } from '@/music-network';
import { ScrobbleDestinationCard } from './ScrobbleDestinationCard';

const account = {
  id: 'acc-1',
  presetId: 'custom',
  wireId: 'audioscrobbler',
  label: 'Test service',
  baseUrl: '',
  scrobbleEnabled: true,
  sessionKey: '',
  username: 'tester',
  apiKey: '',
  apiSecret: '',
  sessionError: false,
  capabilities: {},
  roles: { scrobble: true, enrichmentEligible: false },
} as unknown as Account;

describe('ScrobbleDestinationCard', () => {
  it('leaves the disconnect button outlined', () => {
    renderWithProviders(
      <ScrobbleDestinationCard
        account={account}
        profile={null}
        owedCount={0}
        onToggleScrobble={() => {}}
        onDisconnect={() => {}}
      />,
    );

    // `btn-ghost--flat` strips the outline and is for repeated row icons or a
    // close cross; a disconnect action is neither.
    const button = screen.getByRole('button');
    expect(button).not.toHaveClass('btn-ghost--flat');
  });

  it('says nothing about owed plays when there are none', () => {
    renderWithProviders(
      <ScrobbleDestinationCard
        account={account}
        profile={null}
        owedCount={0}
        onToggleScrobble={() => {}}
        onDisconnect={() => {}}
      />,
    );

    expect(screen.queryByText(/waiting to be sent/i)).not.toBeInTheDocument();
  });

  it('reports plays kept for this destination, with a singular for one', () => {
    renderWithProviders(
      <ScrobbleDestinationCard
        account={account}
        profile={null}
        owedCount={1}
        onToggleScrobble={() => {}}
        onDisconnect={() => {}}
      />,
    );

    expect(screen.getByText('1 play waiting to be sent')).toBeInTheDocument();
  });

  it('uses the plural for several', () => {
    renderWithProviders(
      <ScrobbleDestinationCard
        account={account}
        profile={null}
        owedCount={4}
        onToggleScrobble={() => {}}
        onDisconnect={() => {}}
      />,
    );

    expect(screen.getByText('4 plays waiting to be sent')).toBeInTheDocument();
  });
});
