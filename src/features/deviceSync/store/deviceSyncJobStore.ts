import { create } from 'zustand';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type {
  DeviceSyncLayoutMode,
  DeviceSyncManifestFile,
  DeviceSyncManifestPlaylist,
  DeviceSyncPlaylistPathMode,
  DeviceSyncSource,
} from './deviceSyncStore';

export interface DeviceSyncPlannedPlaylist {
  sourceKey: string;
  name: string;
  pathId?: string;
  relativePath: string;
  tracks: SubsonicSong[];
  references: string[];
}

export interface DeviceSyncJobContext {
  targetDir: string;
  deviceId: string;
  planId: string;
  serverIndexKey: string;
  sources: DeviceSyncSource[];
  deletionSourceKeys: string[];
  layoutMode: DeviceSyncLayoutMode;
  playlistPathMode: DeviceSyncPlaylistPathMode;
  deferredDeletePaths: string[];
  playlists: DeviceSyncPlannedPlaylist[];
  manifestFiles: DeviceSyncManifestFile[];
  manifestPlaylists: DeviceSyncManifestPlaylist[];
}

export type DeviceSyncJobStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export function deviceSyncJobIsActive(status: DeviceSyncJobStatus): boolean {
  return status === 'running' || status === 'cancelling' || status === 'finalizing';
}

export interface DeviceSyncJobState {
  jobId: string | null;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  status: DeviceSyncJobStatus;
  context: DeviceSyncJobContext | null;

  startSync: (jobId: string, total: number, context: DeviceSyncJobContext) => void;
  updateProgress: (done: number, skipped: number, failed: number) => void;
  beginFinalizing: () => void;
  complete: (done: number, skipped: number, failed: number) => void;
  fail: (done: number, skipped: number, failed: number) => void;
  requestCancel: () => void;
  cancelRequestFailed: () => void;
  completeCancelled: (done: number, skipped: number, failed: number) => void;
  reset: () => void;
}

export const useDeviceSyncJobStore = create<DeviceSyncJobState>()((set) => ({
  jobId: null,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  status: 'idle',
  context: null,

  startSync: (jobId, total, context) =>
    set({ jobId, total, done: 0, skipped: 0, failed: 0, status: 'running', context }),

  updateProgress: (done, skipped, failed) =>
    set({ done, skipped, failed }),

  beginFinalizing: () =>
    set({ status: 'finalizing' }),

  complete: (done, skipped, failed) =>
    set({ done, skipped, failed, status: 'done' }),

  fail: (done, skipped, failed) =>
    set({ done, skipped, failed, status: 'failed' }),

  requestCancel: () =>
    set({ status: 'cancelling' }),

  cancelRequestFailed: () =>
    set(state => state.status === 'cancelling' ? { status: 'running' } : state),

  completeCancelled: (done, skipped, failed) =>
    set({ done, skipped, failed, status: 'cancelled' }),

  reset: () =>
    set({ jobId: null, total: 0, done: 0, skipped: 0, failed: 0, status: 'idle', context: null }),
}));
