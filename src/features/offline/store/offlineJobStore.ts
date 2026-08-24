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
  pinKind?: OfflinePinQueueEntry['pinKind'];
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
  setBulkProgress: (groupId: string, progress: { done: number; total: number } | null) => void;
  setPinQueueStatus: (albumId: string, status: OfflinePinQueueEntry['status'], serverId?: string) => void;
  removePinFromQueue: (albumId: string, serverId?: string) => void;
  bumpBulkProgressDone: (groupId: string) => void;
  dropBulkProgressPending: (groupId: string) => void;
  cancelDownload: (
    albumId: string,
    serverId?: string,
    pinKind?: OfflinePinQueueEntry['pinKind'],
  ) => void;
  cancelAllDownloads: () => void;
}

// Module-level cancellation set — checked by downloadAlbum before each track.
export const cancelledDownloads = new Set<string>();
const cancellationListeners = new Map<string, Set<() => void>>();
const bulkCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function markOfflineDownloadCancelled(cancelKey: string): void {
  cancelledDownloads.add(cancelKey);
  const listeners = cancellationListeners.get(cancelKey);
  cancellationListeners.delete(cancelKey);
  for (const listener of listeners ?? []) listener();
}

export function subscribeOfflineDownloadCancellation(
  cancelKey: string,
  listener: () => void,
): () => void {
  if (cancelledDownloads.has(cancelKey)) {
    queueMicrotask(listener);
    return () => {};
  }
  const listeners = cancellationListeners.get(cancelKey) ?? new Set<() => void>();
  listeners.add(listener);
  cancellationListeners.set(cancelKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cancellationListeners.delete(cancelKey);
  };
}

function clearBulkCleanupTimer(groupId: string) {
  const timer = bulkCleanupTimers.get(groupId);
  if (timer) clearTimeout(timer);
  bulkCleanupTimers.delete(groupId);
}

/** Tells Rust to abort any in-flight `download_track_offline` calls for these jobs. */
function abortDownloadsInRust(jobs: DownloadJob[]) {
  const downloadIds = [...new Set(jobs.map(j => j.downloadId).filter(Boolean))];
  if (downloadIds.length > 0) {
    Promise.resolve(cancelOfflineDownloads({ downloadIds })).catch(() => {});
  }
}

export const useOfflineJobStore = create<OfflineJobState>()((set, get) => ({
  jobs: [],
  pinQueue: [],
  bulkProgress: {},

  setBulkProgress: (groupId, progress) => {
    clearBulkCleanupTimer(groupId);
    set(state => {
      if (!progress) {
        const { [groupId]: _removed, ...rest } = state.bulkProgress;
        return { bulkProgress: rest };
      }
      return {
        bulkProgress: {
          ...state.bulkProgress,
          [groupId]: progress,
        },
      };
    });
  },

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
    let completedProgress: { done: number; total: number } | null = null;
    set(state => {
      const cur = state.bulkProgress[groupId];
      if (!cur) return state;
      const done = Math.min(cur.total, cur.done + 1);
      const next = { ...cur, done };
      if (done >= cur.total) completedProgress = next;
      return {
        bulkProgress: {
          ...state.bulkProgress,
          [groupId]: next,
        },
      };
    });
    if (completedProgress) {
      clearBulkCleanupTimer(groupId);
      const completed = completedProgress;
      bulkCleanupTimers.set(groupId, setTimeout(() => {
        bulkCleanupTimers.delete(groupId);
        set(state => {
          if (state.bulkProgress[groupId] !== completed) return state;
          const { [groupId]: _removed, ...rest } = state.bulkProgress;
          return { bulkProgress: rest };
        });
      }, 5000));
    }
  },

  dropBulkProgressPending: (groupId) => {
    set(state => {
      const cur = state.bulkProgress[groupId];
      if (!cur) return state;
      if (cur.total <= cur.done + 1) {
        clearBulkCleanupTimer(groupId);
        const { [groupId]: _removed, ...rest } = state.bulkProgress;
        return { bulkProgress: rest };
      }
      return {
        bulkProgress: {
          ...state.bulkProgress,
          [groupId]: { ...cur, total: cur.total - 1 },
        },
      };
    });
  },

  cancelDownload: (albumId, serverId, pinKind) => {
    const cancelKey = serverId ? `${serverId}:${albumId}` : albumId;
    const activeJobs = get().jobs.filter(j => (
      j.albumId === albumId
        && (!serverId || !j.serverId || j.serverId === serverId)
        && (!pinKind || j.pinKind === pinKind)
        && (j.status === 'queued' || j.status === 'downloading')
    ));
    const hasActiveProducer = get().pinQueue.some(p => (
      p.albumId === albumId
        && (!serverId || !p.serverId || p.serverId === serverId)
        && (!pinKind || p.pinKind === pinKind)
    )) || activeJobs.some(j => j.status === 'downloading');
    if (hasActiveProducer) markOfflineDownloadCancelled(cancelKey);
    // Abort the in-flight Rust transfers, then drop every job for this album
    // (queued AND downloading) so the sidebar toast clears right away.
    abortDownloadsInRust(activeJobs);
    set(state => ({
      jobs: state.jobs.filter(j => (
        j.albumId !== albumId
          || (serverId && j.serverId && j.serverId !== serverId)
          || (pinKind && j.pinKind !== pinKind)
      )),
      pinQueue: state.pinQueue.filter(p => (
        p.albumId !== albumId
          || (serverId && p.serverId && p.serverId !== serverId)
          || (pinKind && p.pinKind !== pinKind)
      )),
    }));
  },

  cancelAllDownloads: () => {
    const active = get().jobs.filter(
      j => j.status === 'queued' || j.status === 'downloading',
    );
    active.forEach(j => markOfflineDownloadCancelled(
      j.serverId ? `${j.serverId}:${j.albumId}` : j.albumId,
    ));
    get().pinQueue.forEach(p => {
      markOfflineDownloadCancelled(p.serverId ? `${p.serverId}:${p.albumId}` : p.albumId);
    });
    abortDownloadsInRust(active);
    for (const groupId of Object.keys(get().bulkProgress)) clearBulkCleanupTimer(groupId);
    // Keep only already-settled jobs (done/error) — the active ones are gone,
    // so the toast disappears instead of lingering on stuck "downloading" rows.
    set(state => ({
      jobs: state.jobs.filter(j => j.status !== 'queued' && j.status !== 'downloading'),
      pinQueue: [],
      bulkProgress: {},
    }));
  },
}));
