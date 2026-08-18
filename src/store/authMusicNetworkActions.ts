import type { PersistedAccount } from '../music-network';
import { clampScrobbleThresholdPercent } from './authStoreDefaults';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Music Network persisted state actions. These back the runtime's
 * MusicNetworkStore port (see musicNetworkBridge.ts) — the runtime is the only
 * caller. Kept synchronous on localStorage like the rest of authStore.
 */
export function createMusicNetworkActions(set: SetState): Pick<
  AuthState,
  | 'setMusicNetworkAccounts'
  | 'setEnrichmentPrimaryId'
  | 'setScrobblingMasterEnabled'
  | 'setScrobbleThresholdPercent'
  | 'setForceScrobbleEnabled'
> {
  return {
    setMusicNetworkAccounts: (accounts: PersistedAccount[]) =>
      set({ musicNetworkAccounts: accounts }),
    setEnrichmentPrimaryId: (id: string | null) =>
      set({ enrichmentPrimaryId: id }),
    setScrobblingMasterEnabled: (v: boolean) =>
      set({ scrobblingMasterEnabled: v }),
    setScrobbleThresholdPercent: (v: number) =>
      set({ scrobbleThresholdPercent: clampScrobbleThresholdPercent(v) }),
    setForceScrobbleEnabled: (v: boolean) =>
      set({ forceScrobbleEnabled: v }),
  };
}
