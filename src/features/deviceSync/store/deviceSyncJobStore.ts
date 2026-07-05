import { create } from 'zustand';

export interface DeviceSyncJobState {
  jobId: string | null;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  status: 'idle' | 'running' | 'done' | 'cancelled';

  startSync: (jobId: string, total: number) => void;
  updateProgress: (done: number, skipped: number, failed: number) => void;
  complete: (done: number, skipped: number, failed: number) => void;
  cancel: () => void;
  reset: () => void;
}

export const useDeviceSyncJobStore = create<DeviceSyncJobState>()((set) => ({
  jobId: null,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  status: 'idle',

  startSync: (jobId, total) =>
    set({ jobId, total, done: 0, skipped: 0, failed: 0, status: 'running' }),

  updateProgress: (done, skipped, failed) =>
    set({ done, skipped, failed }),

  complete: (done, skipped, failed) =>
    set({ done, skipped, failed, status: 'done' }),

  cancel: () =>
    set({ status: 'cancelled' }),

  reset: () =>
    set({ jobId: null, total: 0, done: 0, skipped: 0, failed: 0, status: 'idle' }),
}));
