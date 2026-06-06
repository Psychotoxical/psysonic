import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface DownloadJob {
  trackId: string;
  albumId: string;
  albumName: string;
  trackTitle: string;
  trackIndex: number;
  totalTracks: number;
  status: 'queued' | 'downloading' | 'done' | 'error';
  /** Unique per `downloadAlbum` run — keys the Rust-side cancellation flag. */
  downloadId: string;
}

export interface OfflinePinQueueEntry {
  albumId: string;
  albumName: string;
  pinKind: 'album' | 'playlist' | 'artist' | 'track';
  status: 'queued' | 'downloading';
  queuedAt: number;
}

interface OfflineJobState {
  jobs: DownloadJob[];
  /** Album / playlist / artist pins waiting for or undergoing download. */
  pinQueue: OfflinePinQueueEntry[];
  bulkProgress: Record<string, { done: number; total: number }>;
  setPinQueueStatus: (albumId: string, status: OfflinePinQueueEntry['status']) => void;
  removePinFromQueue: (albumId: string) => void;
  bumpBulkProgressDone: (groupId: string) => void;
  cancelDownload: (albumId: string) => void;
  cancelAllDownloads: () => void;
}

// Module-level cancellation set — checked by downloadAlbum before each track.
export const cancelledDownloads = new Set<string>();

/** Tells Rust to abort any in-flight `download_track_offline` calls for these jobs. */
function abortDownloadsInRust(jobs: DownloadJob[]) {
  const downloadIds = [...new Set(jobs.map(j => j.downloadId).filter(Boolean))];
  if (downloadIds.length > 0) {
    invoke('cancel_offline_downloads', { downloadIds }).catch(() => {});
  }
}

export const useOfflineJobStore = create<OfflineJobState>()((set, get) => ({
  jobs: [],
  pinQueue: [],
  bulkProgress: {},

  setPinQueueStatus: (albumId, status) => {
    set(state => ({
      pinQueue: state.pinQueue.map(p => (p.albumId === albumId ? { ...p, status } : p)),
    }));
  },

  removePinFromQueue: (albumId) => {
    set(state => ({
      pinQueue: state.pinQueue.filter(p => p.albumId !== albumId),
    }));
  },

  bumpBulkProgressDone: (groupId) => {
    set(state => {
      const cur = state.bulkProgress[groupId];
      if (!cur) return state;
      const done = Math.min(cur.total, cur.done + 1);
      return {
        bulkProgress: {
          ...state.bulkProgress,
          [groupId]: { ...cur, done },
        },
      };
    });
  },

  cancelDownload: (albumId) => {
    cancelledDownloads.add(albumId);
    // Abort the in-flight Rust transfers, then drop every job for this album
    // (queued AND downloading) so the sidebar toast clears right away.
    abortDownloadsInRust(get().jobs.filter(j => j.albumId === albumId));
    set(state => ({
      jobs: state.jobs.filter(j => j.albumId !== albumId),
      pinQueue: state.pinQueue.filter(p => p.albumId !== albumId),
    }));
  },

  cancelAllDownloads: () => {
    const active = get().jobs.filter(
      j => j.status === 'queued' || j.status === 'downloading',
    );
    [...new Set(active.map(j => j.albumId))].forEach(id => cancelledDownloads.add(id));
    [...get().pinQueue.map(p => p.albumId)].forEach(id => cancelledDownloads.add(id));
    abortDownloadsInRust(active);
    // Keep only already-settled jobs (done/error) — the active ones are gone,
    // so the toast disappears instead of lingering on stuck "downloading" rows.
    set(state => ({
      jobs: state.jobs.filter(j => j.status !== 'queued' && j.status !== 'downloading'),
      pinQueue: [],
    }));
  },
}));
