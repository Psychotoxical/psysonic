import { create } from 'zustand';
import { cancelOfflineDownloads } from '@/lib/api/syncfs';

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
  serverId?: string;
}

export interface OfflinePinQueueEntry {
  albumId: string;
  albumName: string;
  pinKind: 'album' | 'playlist' | 'artist' | 'track';
  status: 'queued' | 'downloading';
  queuedAt: number;
  serverId?: string;
}

interface OfflineJobState {
  jobs: DownloadJob[];
  /** Album / playlist / artist pins waiting for or undergoing download. */
  pinQueue: OfflinePinQueueEntry[];
  bulkProgress: Record<string, { done: number; total: number }>;
  setPinQueueStatus: (albumId: string, status: OfflinePinQueueEntry['status'], serverId?: string) => void;
  removePinFromQueue: (albumId: string, serverId?: string) => void;
  bumpBulkProgressDone: (groupId: string) => void;
  cancelDownload: (albumId: string, serverId?: string) => void;
  cancelAllDownloads: () => void;
}

// Module-level cancellation set — checked by downloadAlbum before each track.
export const cancelledDownloads = new Set<string>();

/** Tells Rust to abort any in-flight `download_track_offline` calls for these jobs. */
function abortDownloadsInRust(jobs: DownloadJob[]) {
  const downloadIds = [...new Set(jobs.map(j => j.downloadId).filter(Boolean))];
  if (downloadIds.length > 0) {
    cancelOfflineDownloads({ downloadIds }).catch(() => {});
  }
}

export const useOfflineJobStore = create<OfflineJobState>()((set, get) => ({
  jobs: [],
  pinQueue: [],
  bulkProgress: {},

  setPinQueueStatus: (albumId, status, serverId) => {
    set(state => ({
      pinQueue: state.pinQueue.map(p => (
        p.albumId === albumId && (!serverId || !p.serverId || p.serverId === serverId)
          ? { ...p, status }
          : p
      )),
    }));
  },

  removePinFromQueue: (albumId, serverId) => {
    set(state => ({
      pinQueue: state.pinQueue.filter(p => (
        p.albumId !== albumId || (serverId && p.serverId && p.serverId !== serverId)
      )),
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

  cancelDownload: (albumId, serverId) => {
    const cancelKey = serverId ? `${serverId}:${albumId}` : albumId;
    const activeJobs = get().jobs.filter(j => (
      j.albumId === albumId
        && (!serverId || !j.serverId || j.serverId === serverId)
        && (j.status === 'queued' || j.status === 'downloading')
    ));
    const hasActiveProducer = get().pinQueue.some(p => (
      p.albumId === albumId
        && (!serverId || !p.serverId || p.serverId === serverId)
        && p.status === 'downloading'
    )) || activeJobs.some(j => j.status === 'downloading');
    if (hasActiveProducer) cancelledDownloads.add(cancelKey);
    // Abort the in-flight Rust transfers, then drop every job for this album
    // (queued AND downloading) so the sidebar toast clears right away.
    abortDownloadsInRust(activeJobs);
    set(state => ({
      jobs: state.jobs.filter(j => (
        j.albumId !== albumId || (serverId && j.serverId && j.serverId !== serverId)
      )),
      pinQueue: state.pinQueue.filter(p => (
        p.albumId !== albumId || (serverId && p.serverId && p.serverId !== serverId)
      )),
    }));
  },

  cancelAllDownloads: () => {
    const active = get().jobs.filter(
      j => j.status === 'queued' || j.status === 'downloading',
    );
    active.forEach(j => cancelledDownloads.add(j.serverId ? `${j.serverId}:${j.albumId}` : j.albumId));
    get().pinQueue
      .filter(p => p.status === 'downloading')
      .forEach(p => cancelledDownloads.add(p.serverId ? `${p.serverId}:${p.albumId}` : p.albumId));
    abortDownloadsInRust(active);
    // Keep only already-settled jobs (done/error) — the active ones are gone,
    // so the toast disappears instead of lingering on stuck "downloading" rows.
    set(state => ({
      jobs: state.jobs.filter(j => j.status !== 'queued' && j.status !== 'downloading'),
      pinQueue: [],
    }));
  },
}));
