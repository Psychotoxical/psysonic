// State port for the runtime.
//
// The runtime never imports the auth store directly — it reads and writes the
// persisted MusicNetworkState through this port, which Phase 5 backs with the
// auth store. Keeping it an interface lets the engine be unit-tested with an
// in-memory implementation.

import type { MusicNetworkState, PersistedAccount } from '../core/accounts';

export interface MusicNetworkStore {
  getState(): MusicNetworkState;
  setAccounts(accounts: PersistedAccount[]): void;
  setEnrichmentPrimaryId(id: string | null): void;
}

/** Side effects the runtime needs from the host (Tauri shell / app). */
export interface RuntimeHost {
  /** Opens an external URL (Tauri shell) for browser auth flows. */
  openExternal(url: string): Promise<void>;
  /** Generates a unique account id (uuid). */
  newId(): string;
}
