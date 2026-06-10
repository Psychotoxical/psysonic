// Runtime singleton. Initialized once at app start (Phase 5 wires the store to
// the auth store and the host to the Tauri shell). App code calls
// getMusicNetworkRuntime() everywhere else.

import { registerBuiltinWires } from '../registry/registerBuiltinWires';
import { MusicNetworkRuntime } from './MusicNetworkRuntime';
import type { MusicNetworkStore, RuntimeHost } from './store';

let instance: MusicNetworkRuntime | null = null;

export function initMusicNetworkRuntime(
  store: MusicNetworkStore,
  host: RuntimeHost,
): MusicNetworkRuntime {
  registerBuiltinWires();
  instance = new MusicNetworkRuntime(store, host);
  return instance;
}

export function getMusicNetworkRuntime(): MusicNetworkRuntime {
  if (!instance) {
    throw new Error('Music Network runtime not initialized — call initMusicNetworkRuntime() at startup');
  }
  return instance;
}

/** Test seam. */
export function __setMusicNetworkRuntime(rt: MusicNetworkRuntime | null): void {
  instance = rt;
}
