// Wires the Music Network runtime singleton to the app: the auth store backs the
// MusicNetworkStore port (reads are live via getState, so init order vs. rehydrate
// does not matter), and the Tauri shell backs the host (browser auth + uuid).

import { open } from '@tauri-apps/plugin-shell';
import { initMusicNetworkRuntime } from '../music-network/runtime/getMusicNetworkRuntime';
import type { MusicNetworkStore, RuntimeHost } from '../music-network/runtime/store';
import { useAuthStore } from '../store/authStore';

const store: MusicNetworkStore = {
  getState: () => {
    const s = useAuthStore.getState();
    return {
      scrobblingMasterEnabled: s.scrobblingMasterEnabled,
      enrichmentPrimaryId: s.enrichmentPrimaryId,
      accounts: s.musicNetworkAccounts,
    };
  },
  setAccounts: accounts => useAuthStore.getState().setMusicNetworkAccounts(accounts),
  setEnrichmentPrimaryId: id => useAuthStore.getState().setEnrichmentPrimaryId(id),
};

const host: RuntimeHost = {
  openExternal: url => open(url),
  newId: () => crypto.randomUUID(),
};

let initialized = false;

/** Initialize the Music Network runtime once, before any consumer calls it. */
export function setupMusicNetworkRuntime(): void {
  if (initialized) return;
  initialized = true;
  initMusicNetworkRuntime(store, host);
}
