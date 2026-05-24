import { create } from 'zustand';
import type { MigrationInspectReport, MigrationProgressEvent } from '../api/migration';

export type MigrationPhase = 'idle' | 'inspecting' | 'running' | 'completed' | 'error';
const MIGRATION_DONE_FLAG = 'psysonic-server-key-migration-v1';

function initialMigrationPhase(): MigrationPhase {
  if (typeof window === 'undefined') return 'inspecting';
  return localStorage.getItem(MIGRATION_DONE_FLAG) === '1' ? 'completed' : 'inspecting';
}

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
  phase: initialMigrationPhase(),
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
