import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/store/authStore';
import { getPreset, type Account, type QueuedScrobble } from '@/music-network';

/**
 * Reactive view of the persisted Music Network state for the Integrations UI.
 * Accounts re-render on any auth-store change; roles are derived from the preset
 * manifest (static). Mutations go through the runtime (see MusicNetworkSection),
 * which writes back to the store and re-renders this.
 */
export function useMusicNetworkState(): {
  accounts: Account[];
  enrichmentPrimaryId: string | null;
  scrobblingMasterEnabled: boolean;
  scrobbleQueue: QueuedScrobble[];
} {
  const { accounts, enrichmentPrimaryId, scrobblingMasterEnabled, scrobbleQueue } = useAuthStore(
    useShallow(s => ({
      accounts: s.musicNetworkAccounts,
      enrichmentPrimaryId: s.enrichmentPrimaryId,
      scrobblingMasterEnabled: s.scrobblingMasterEnabled,
      // Drives the per-destination "waiting to be sent" count. Reading it here
      // makes the card reactive: a delivery or a fresh failure updates the number
      // without the UI polling anything.
      scrobbleQueue: s.musicNetworkScrobbleQueue,
    })),
  );

  const richAccounts = useMemo<Account[]>(
    () =>
      accounts.map(a => ({
        ...a,
        roles:
          getPreset(a.presetId)?.manifest.defaultRoles
          ?? { scrobble: false, enrichmentEligible: false },
      })),
    [accounts],
  );

  return { accounts: richAccounts, enrichmentPrimaryId, scrobblingMasterEnabled, scrobbleQueue };
}
