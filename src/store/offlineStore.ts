import { buildStreamUrl } from '../api/subsonicStreamUrl';
import { getAlbum } from '../api/subsonicLibrary';
import { getArtist } from '../api/subsonicArtists';
import type { SubsonicSong } from '../api/subsonicTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from './authStore';
import { showToast } from '../utils/ui/toast';
import { useOfflineJobStore, cancelledDownloads } from './offlineJobStore';
import { emitAnalysisStorageChanged } from './analysisSync';

export interface OfflineTrackMeta {
  id: string;
  serverId: string;
  localPath: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  suffix: string;
  duration: number;
  bitRate?: number;
  coverArt?: string;
  year?: number;
  genre?: string;
  replayGainTrackDb?: number;
  replayGainAlbumDb?: number;
  replayGainPeak?: number;
  cachedAt: string;
}

export interface OfflineAlbumMeta {
  id: string;
  serverId: string;
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
  trackIds: string[];
  type?: 'album' | 'playlist' | 'artist';
}

// Re-export for components that import DownloadJob from offlineStore.
export type { DownloadJob } from './offlineJobStore';

interface OfflineState {
  tracks: Record<string, OfflineTrackMeta>;   // key: `${serverId}:${trackId}`
  albums: Record<string, OfflineAlbumMeta>;   // key: `${serverId}:${albumId}`

  isDownloaded: (trackId: string, serverId: string) => boolean;
  isAlbumDownloaded: (albumId: string, serverId: string) => boolean;
  isAlbumDownloading: (albumId: string) => boolean;
  getLocalUrl: (trackId: string, serverId: string) => string | null;
  downloadAlbum: (
    albumId: string,
    albumName: string,
    albumArtist: string,
    coverArt: string | undefined,
    year: number | undefined,
    songs: SubsonicSong[],
    serverId: string,
    type?: 'album' | 'playlist' | 'artist',
  ) => Promise<void>;
  downloadPlaylist: (playlistId: string, playlistName: string, coverArt: string | undefined, songs: SubsonicSong[], serverId: string) => Promise<void>;
  downloadArtist: (artistId: string, artistName: string, serverId: string) => Promise<void>;
  deleteAlbum: (albumId: string, serverId: string) => Promise<void>;
  clearAll: (serverId: string) => Promise<void>;
  getAlbumProgress: (albumId: string) => { done: number; total: number } | null;
}

export const useOfflineStore = create<OfflineState>()(
  persist(
    (set, get) => ({
      tracks: {},
      albums: {},

      isDownloaded: (trackId, serverId) =>
        !!get().tracks[`${serverId}:${trackId}`],

      isAlbumDownloaded: (albumId, serverId) => {
        const album = get().albums[`${serverId}:${albumId}`];
        if (!album || album.trackIds.length === 0) return false;
        return album.trackIds.every(tid => !!get().tracks[`${serverId}:${tid}`]);
      },

      isAlbumDownloading: (albumId) =>
        useOfflineJobStore.getState().jobs.some(
          j => j.albumId === albumId && (j.status === 'queued' || j.status === 'downloading')
        ),

      getLocalUrl: (trackId, serverId) => {
        const meta = get().tracks[`${serverId}:${trackId}`];
        if (!meta) return null;
        return `psysonic-local://${meta.localPath}`;
      },

      clearAll: async (serverId) => {
        const albumKeys = Object.keys(get().albums).filter(k => k.startsWith(`${serverId}:`));
        for (const key of albumKeys) {
          const albumId = key.slice(`${serverId}:`.length);
          await get().deleteAlbum(albumId, serverId);
        }
      },

      getAlbumProgress: (albumId) => {
        const albumJobs = useOfflineJobStore.getState().jobs.filter(j => j.albumId === albumId);
        if (albumJobs.length === 0) return null;
        const done = albumJobs.filter(j => j.status === 'done' || j.status === 'error').length;
        return { done, total: albumJobs.length };
      },

      downloadAlbum: async (albumId, albumName, albumArtist, coverArt, year, songs, serverId, type = 'album') => {
        // Frontend fires up to 8 invoke calls at a time so Rust always has work queued.
        // The backend Semaphore (MAX_DL_CONCURRENCY = 4) is the real throttle —
        // at most 4 HTTP streams run simultaneously regardless of this value.
        const CONCURRENCY = 8;
        const trackIds = songs.map(s => s.id);
        const jobStore = useOfflineJobStore;
        // Unique per run — keys the Rust-side cancellation flag so the X button
        // can abort in-flight transfers, not just stop queuing new ones.
        const downloadId = `${albumId}-${Date.now()}`;

        // Pre-flight: verify the target directory is accessible before queuing anything.
        const customDir = useAuthStore.getState().offlineDownloadDir || null;
        if (customDir) {
          const ok = await invoke<boolean>('check_dir_accessible', { path: customDir }).catch(() => false);
          if (!ok) {
            showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
            return;
          }
        }

        // Register album in persisted store — 1 localStorage write.
        set(state => ({
          albums: {
            ...state.albums,
            [`${serverId}:${albumId}`]: { id: albumId, serverId, name: albumName, artist: albumArtist, coverArt, year, trackIds, type },
          },
        }));

        // Queue jobs in the non-persisted job store — zero localStorage writes.
        jobStore.setState(state => ({
          jobs: [
            ...state.jobs.filter(j => j.albumId !== albumId),
            ...songs.map((s, i) => ({
              trackId: s.id,
              albumId,
              albumName,
              trackTitle: s.title,
              trackIndex: i,
              totalTracks: songs.length,
              status: 'queued' as const,
              downloadId,
            })),
          ],
        }));

        // Accumulate completed tracks locally — persisted in ONE write at the very end.
        const completedTracks: Record<string, OfflineTrackMeta> = {};

        for (let i = 0; i < songs.length; i += CONCURRENCY) {
          // Abort if the user cancelled this download.
          if (cancelledDownloads.has(albumId)) {
            cancelledDownloads.delete(albumId);
            // Persist whatever finished before the cancel so files already on
            // disk are not orphaned, then drop the remaining jobs.
            if (Object.keys(completedTracks).length > 0) {
              set(state => ({ tracks: { ...state.tracks, ...completedTracks } }));
            }
            jobStore.setState(state => ({ jobs: state.jobs.filter(j => j.albumId !== albumId) }));
            invoke('clear_offline_cancel', { downloadId }).catch(() => {});
            return;
          }

          const batch = songs.slice(i, i + CONCURRENCY);
          const batchIds = new Set(batch.map(s => s.id));

          // Mark batch as downloading — job store only, no localStorage write.
          jobStore.setState(state => ({
            jobs: state.jobs.map(j =>
              j.albumId === albumId && batchIds.has(j.trackId)
                ? { ...j, status: 'downloading' }
                : j,
            ),
          }));

          // Run all downloads concurrently, collect results without touching any store.
          const results = await Promise.all(
            batch.map(async song => {
              const suffix = song.suffix || 'mp3';
              // Skip tracks not yet started once the user cancels mid-batch —
              // the per-batch check above only catches whole batches.
              if (cancelledDownloads.has(albumId)) {
                return { song, suffix, localPath: null as string | null, error: 'CANCELLED' };
              }
              try {
                const localPath = await invoke<string>('download_track_offline', {
                  trackId: song.id,
                  serverId,
                  url: buildStreamUrl(song.id),
                  suffix,
                  customDir,
                  downloadId,
                });
                return { song, suffix, localPath, error: null as string | null };
              } catch (err) {
                const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : '');
                if (msg === 'VOLUME_NOT_FOUND' && !cancelledDownloads.has(albumId)) {
                  cancelledDownloads.add(albumId);
                  showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
                }
                return { song, suffix, localPath: null as string | null, error: msg };
              }
            }),
          );

          // Accumulate completed tracks locally (no store write yet).
          for (const { song, suffix, localPath } of results) {
            if (localPath) {
              completedTracks[`${serverId}:${song.id}`] = {
                id: song.id,
                serverId,
                localPath,
                title: song.title,
                artist: song.artist,
                album: song.album,
                albumId: song.albumId,
                artistId: song.artistId,
                suffix,
                duration: song.duration,
                bitRate: song.bitRate,
                coverArt: song.coverArt,
                year: song.year,
                genre: song.genre,
                replayGainTrackDb: song.replayGain?.trackGain,
                replayGainAlbumDb: song.replayGain?.albumGain,
                replayGainPeak: song.replayGain?.trackPeak,
                cachedAt: new Date().toISOString(),
              };
            }
          }

          // Update job statuses — job store only, no localStorage write.
          const resultMap = new Map(results.map(r => [r.song.id, r]));
          jobStore.setState(state => ({
            jobs: state.jobs.map(j => {
              if (j.albumId !== albumId) return j;
              const r = resultMap.get(j.trackId);
              if (!r) return j;
              // A cancelled track is not a failure — leave the job for the
              // cancel path to drop rather than flashing it red.
              if (r.error === 'CANCELLED') return j;
              return { ...j, status: r.localPath ? 'done' : 'error' };
            }),
          }));
        }

        // Persist all completed tracks in ONE localStorage write.
        set(state => ({ tracks: { ...state.tracks, ...completedTracks } }));
        invoke('clear_offline_cancel', { downloadId }).catch(() => {});

        // Clear completed jobs after a short delay.
        setTimeout(() => {
          jobStore.setState(state => ({
            jobs: state.jobs.filter(
              j => j.albumId !== albumId || (j.status !== 'done' && j.status !== 'error'),
            ),
          }));
        }, 2500);
      },

      downloadPlaylist: async (playlistId, playlistName, coverArt, songs, serverId) => {
        // Deduplicate songs (a track can appear multiple times in a playlist).
        const seen = new Set<string>();
        const unique = songs.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
        // Store the entire playlist as one virtual album entry so the Offline Library
        // shows a single card for the playlist rather than one card per album.
        await get().downloadAlbum(playlistId, playlistName, '', coverArt, undefined, unique, serverId, 'playlist');
      },

      downloadArtist: async (artistId, artistName, serverId) => {
        const jobStore = useOfflineJobStore;
        let albums: { id: string; name: string; artist: string; coverArt?: string; year?: number }[] = [];
        try {
          const res = await getArtist(artistId);
          albums = res.albums;
        } catch { return; }
        jobStore.setState(state => ({
          bulkProgress: { ...state.bulkProgress, [artistId]: { done: 0, total: albums.length } },
        }));
        for (let i = 0; i < albums.length; i++) {
          const album = albums[i];
          try {
            const { songs } = await getAlbum(album.id);
            await get().downloadAlbum(album.id, album.name, album.artist || artistName, album.coverArt, album.year, songs, serverId, 'artist');
          } catch { /* skip failed album */ }
          jobStore.setState(state => ({
            bulkProgress: { ...state.bulkProgress, [artistId]: { done: i + 1, total: albums.length } },
          }));
        }
        setTimeout(() => {
          jobStore.setState(state => {
            const { [artistId]: _removed, ...rest } = state.bulkProgress;
            return { bulkProgress: rest };
          });
        }, 3000);
      },

      deleteAlbum: async (albumId, serverId) => {
        const album = get().albums[`${serverId}:${albumId}`];
        if (!album) return;

        await Promise.all(
          album.trackIds.map(async trackId => {
            const meta = get().tracks[`${serverId}:${trackId}`];
            if (!meta) return;
            await invoke('delete_offline_track', {
              localPath: meta.localPath,
              baseDir: useAuthStore.getState().offlineDownloadDir || null,
            }).catch(() => {});
          }),
        );
        for (const trackId of album.trackIds) {
          emitAnalysisStorageChanged({ trackId, reason: 'offline-delete' });
        }

        set(state => {
          const tracks = { ...state.tracks };
          album.trackIds.forEach(tid => delete tracks[`${serverId}:${tid}`]);
          const albums = { ...state.albums };
          delete albums[`${serverId}:${albumId}`];
          return { tracks, albums };
        });
      },
    }),
    {
      name: 'psysonic-offline',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ tracks: state.tracks, albums: state.albums }),
    },
  ),
);
