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

interface OfflineJobState {
  jobs: DownloadJob[];
  bulkProgress: Record<string, { done: number; total: number }>;
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
  bulkProgress: {},

  cancelDownload: (albumId) => {
    cancelledDownloads.add(albumId);
    // Abort the in-flight Rust transfers, then drop every job for this album
    // (queued AND downloading) so the sidebar toast clears right away.
    abortDownloadsInRust(get().jobs.filter(j => j.albumId === albumId));
    set(state => ({
      jobs: state.jobs.filter(j => j.albumId !== albumId),
    }));
  },

  cancelAllDownloads: () => {
    const active = get().jobs.filter(
      j => j.status === 'queued' || j.status === 'downloading',
    );
    [...new Set(active.map(j => j.albumId))].forEach(id => cancelledDownloads.add(id));
    abortDownloadsInRust(active);
    // Keep only already-settled jobs (done/error) — the active ones are gone,
    // so the toast disappears instead of lingering on stuck "downloading" rows.
    set(state => ({
      jobs: state.jobs.filter(j => j.status !== 'queued' && j.status !== 'downloading'),
    }));
  },
}));
