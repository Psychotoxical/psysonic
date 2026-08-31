// Wires the Music Network runtime singleton to the app: the auth store backs the
// MusicNetworkStore port (reads are live via getState, so init order vs. rehydrate
// does not matter), and the Tauri shell backs the host (browser auth + uuid).

import { open } from '@tauri-apps/plugin-shell';
import { getMusicNetworkRuntimeOrNull, initMusicNetworkRuntime } from '../music-network/runtime/getMusicNetworkRuntime';
import type { MusicNetworkStore, RuntimeHost } from '../music-network/runtime/store';
import { useAuthStore } from '../store/authStore';

const store: MusicNetworkStore = {
  getState: () => {
    const s = useAuthStore.getState();
    return {
      scrobblingMasterEnabled: s.scrobblingMasterEnabled,
      enrichmentPrimaryId: s.enrichmentPrimaryId,
      accounts: s.musicNetworkAccounts,
      scrobbleQueue: s.musicNetworkScrobbleQueue,
    };
  },
  setAccounts: accounts => useAuthStore.getState().setMusicNetworkAccounts(accounts),
  setEnrichmentPrimaryId: id => useAuthStore.getState().setEnrichmentPrimaryId(id),
  setScrobbleQueue: queue => useAuthStore.getState().setMusicNetworkScrobbleQueue(queue),
};

const host: RuntimeHost = {
  openExternal: url => open(url),
  newId: () => crypto.randomUUID(),
};

let initialized = false;

/**
 * How often owed scrobbles are reconsidered. Entries carry their own backoff, so
 * a tick that finds nothing due costs a comparison and no request.
 */
const OWED_FLUSH_INTERVAL_MS = 5 * 60_000;

/**
 * Retry owed scrobbles on app start, when connectivity returns, and periodically.
 *
 * The `online` event is only ever an *anchor* to try again — never a condition.
 * navigator's offline hint is unreliable under Tauri (#1234), so a queue must not
 * depend on it to drain.
 */
function startOwedScrobbleFlushing(): void {
  const flush = () => {
    // A rejection here must not escape: this fires from three triggers, and the
    // queue rides in the persisted auth blob — a full localStorage would reject on
    // every one of them, forever, with nobody to catch it.
    void getMusicNetworkRuntimeOrNull()
      ?.flushOwedScrobbles()
      .catch(() => {});
  };
  flush();
  // Both the listener and the timer are browser-only; a non-browser import must
  // not be left holding a live interval that fires into an unrelated store.
  if (typeof window === 'undefined') return;
  window.addEventListener('online', flush);
  // Lives for the process; the runtime is a singleton owned by the app shell.
  setInterval(flush, OWED_FLUSH_INTERVAL_MS);
}

/** Initialize the Music Network runtime once, before any consumer calls it. */
export function setupMusicNetworkRuntime(): void {
  if (initialized) return;
  initialized = true;
  initMusicNetworkRuntime(store, host);
  startOwedScrobbleFlushing();
}
