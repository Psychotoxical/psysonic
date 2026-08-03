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
        onToggleScrobble={() => {}}
        onDisconnect={() => {}}
      />,
    );

    // `btn-ghost--flat` strips the outline and is for repeated row icons or a
    // close cross; a disconnect action is neither.
    const button = screen.getByRole('button');
    expect(button).not.toHaveClass('btn-ghost--flat');
  });
});
