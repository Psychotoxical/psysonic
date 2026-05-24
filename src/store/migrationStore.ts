import { create } from 'zustand';
import type { MigrationInspectReport, MigrationProgressEvent } from '../api/migration';

export type MigrationPhase = 'idle' | 'inspecting' | 'running' | 'completed' | 'error';

interface MigrationState {
  phase: MigrationPhase;
  needsMigration: boolean;
  inspect: MigrationInspectReport | null;
  progress: MigrationProgressEvent | null;
  lastError: string | null;
  setPhase: (phase: MigrationPhase) => void;
  setNeedsMigration: (needsMigration: boolean) => void;
  setInspect: (report: MigrationInspectReport | null) => void;
  setProgress: (event: MigrationProgressEvent | null) => void;
  setError: (error: string | null) => void;
}

export const useMigrationStore = create<MigrationState>(set => ({
  phase: 'idle',
  needsMigration: false,
  inspect: null,
  progress: null,
  lastError: null,
  setPhase: phase => set({ phase }),
  setNeedsMigration: needsMigration => set({ needsMigration }),
  setInspect: inspect => set({ inspect }),
  setProgress: progress => set({ progress }),
  setError: lastError => set({ lastError }),
}));
