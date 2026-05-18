import { create } from 'zustand';

export type ScanPhase = 'idle' | 'starting' | 'running' | 'just-finished' | 'error';

export interface ScanEntry {
  phase: ScanPhase;
  type: 'quick' | 'full';
  count: number;
  /** Set while user is in "press again to confirm" state for a full scan. */
  confirmingFull: boolean;
}

const EMPTY: ScanEntry = { phase: 'idle', type: 'quick', count: 0, confirmingFull: false };

interface ScanState {
  byServer: Record<string, ScanEntry>;
  get: (serverId: string) => ScanEntry;
  set: (serverId: string, patch: Partial<ScanEntry>) => void;
  clear: (serverId: string) => void;
}

export const useScanStore = create<ScanState>((set, getState) => ({
  byServer: {},
  get: (serverId) => getState().byServer[serverId] ?? EMPTY,
  set: (serverId, patch) => set(s => ({
    byServer: { ...s.byServer, [serverId]: { ...(s.byServer[serverId] ?? EMPTY), ...patch } },
  })),
  clear: (serverId) => set(s => {
    const next = { ...s.byServer };
    delete next[serverId];
    return { byServer: next };
  }),
}));
