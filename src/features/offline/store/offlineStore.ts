import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { buildStreamUrl } from '@/lib/api/subsonicStreamUrl';
import { getAlbum } from '@/lib/api/subsonicLibrary';
import { getArtist } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '@/store/authStore';
import { showToast } from '@/lib/dom/toast';
import { useOfflineJobStore, cancelledDownloads } from '@/features/offline/store/offlineJobStore';
import { useLocalPlaybackStore, type PinSource } from '@/store/localPlaybackStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { checkDirAccessible, clearOfflineCancel } from '@/lib/api/syncfs';
import { findLocalPlaybackEntry } from '@/store/localPlaybackResolve';
import {
  isOfflinePinComplete,
  pendingOfflinePinSongs,
} from '@/features/offline/utils/offlineLibraryHelpers';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { isSmartPlaylistName } from '@/lib/format/playlistDetailHelpers';
import {
  enqueueOfflinePin,
  registerOfflinePinExecutor,
  removeOfflinePinTask,
  type OfflinePinTask,
} from '@/features/offline/utils/offlinePinQueue';

/** @deprecated Metadata lives in the library index; kept for type-compat during transition. */
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

/** @deprecated Grouping uses `pinSource` on local playback entries. */
export interface OfflineAlbumMeta {
  id: string;
  serverId: string;
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
  trackIds: string[];
  type?: 'album' | 'playlist' | 'artist' | 'track';
}

export type { DownloadJob } from '@/features/offline/store/offlineJobStore';

function serverIndexKeyForOffline(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

/** Library SQLite scope (host index key) — not the auth profile UUID. */
function librarySqlScopeForOffline(serverId: string): string {
  return librarySqlServerId(serverId);
}

/** Runs one queued offline pin (all tracks for a single album / playlist). */
async function runOfflinePinDownload(task: OfflinePinTask): Promise<void> {
  const {
    albumId,
    albumName,
    albumArtist,
    coverArt,
    year,
    songs,
    serverId,
    type = 'album',
  } = task;
  if (cancelledDownloads.has(albumId)) return;
  cancelledDownloads.delete(albumId);

  const CONCURRENCY = 8;
  const trackIds = songs.map(s => s.id);
  const jobStore = useOfflineJobStore;
  const downloadId = `${albumId}-${Date.now()}`;
  const serverIndexKey = serverIndexKeyForOffline(serverId);
  const libraryServerId = librarySqlScopeForOffline(serverId);
  const pinSource: PinSource = { kind: type, sourceId: albumId, displayName: albumName };
  const mediaDir = getMediaDir();

  if (mediaDir) {
    const ok = await checkDirAccessible({ path: mediaDir }).catch(() => false);
    if (!ok) {
      showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
      return;
    }
  }

  useOfflineStore.setState(state => ({
    albums: {
      ...state.albums,
      [`${serverIndexKey}:${albumId}`]: {
        id: albumId,
        serverId: serverIndexKey,
        name: albumName,
        artist: albumArtist,
        coverArt,
        year,
        trackIds,
        type,
      },
    },
  }));

  await libraryUpsertSongsFromApi(libraryServerId, songs).catch(() => {});

  const lp = useLocalPlaybackStore.getState();
  const pendingSongs = pendingOfflinePinSongs(songs, serverId);
  if (pendingSongs.length === 0) {
    for (const song of songs) {
      const prev = findLocalPlaybackEntry(song.id, serverId);
      if (!prev) continue;
      lp.upsertEntry({
        ...prev,
        serverIndexKey,
        tier: 'library',
        pinSource,
      });
    }
    jobStore.setState(state => ({
      jobs: state.jobs.filter(j => j.albumId !== albumId),
    }));
    return;
  }

  jobStore.setState(state => ({
    jobs: [
      ...state.jobs.filter(j => j.albumId !== albumId),
      ...pendingSongs.map((s, i) => ({
        serverId,
        trackId: s.id,
        albumId,
        albumName,
        trackTitle: s.title,
        trackIndex: i,
        totalTracks: pendingSongs.length,
        status: 'queued' as const,
        downloadId,
      })),
    ],
  }));

  for (let i = 0; i < pendingSongs.length; i += CONCURRENCY) {
    if (cancelledDownloads.has(albumId)) {
      cancelledDownloads.delete(albumId);
      jobStore.setState(state => ({ jobs: state.jobs.filter(j => j.albumId !== albumId) }));
      clearOfflineCancel({ downloadId }).catch(() => {});
      return;
    }

    const batch = pendingSongs.slice(i, i + CONCURRENCY);
    const batchIds = new Set(batch.map(s => s.id));

    jobStore.setState(state => ({
      jobs: state.jobs.map(j =>
        j.albumId === albumId && batchIds.has(j.trackId)
          ? { ...j, status: 'downloading' }
          : j,
      ),
    }));

    const results = await Promise.all(
      batch.map(async song => {
        const suffix = song.suffix || 'mp3';
        if (cancelledDownloads.has(albumId)) {
          return { song, localPath: null as string | null, error: 'CANCELLED' };
        }
        const existing = findLocalPlaybackEntry(song.id, serverId);
        if (existing?.tier === 'library' && existing.localPath) {
          useLocalPlaybackStore.getState().upsertEntry({
            ...existing,
            serverIndexKey,
            pinSource,
            suffix: existing.suffix || suffix,
          });
          return { song, localPath: existing.localPath, error: null as string | null };
        }
        try {
          const res = await invoke<{ path: string; size: number; layoutFingerprint: string }>(
            'download_track_local',
            {
              tier: 'library',
              trackId: song.id,
              serverIndexKey,
              libraryServerId,
              url: buildStreamUrl(song.id),
              suffix,
              mediaDir,
              downloadId,
            },
          );
          useLocalPlaybackStore.getState().upsertEntry({
            serverIndexKey,
            trackId: song.id,
            localPath: res.path,
            sizeBytes: res.size,
            layoutFingerprint: res.layoutFingerprint,
            tier: 'library',
            pinSource,
            suffix,
          });
          return { song, localPath: res.path, error: null as string | null };
        } catch (err) {
          const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : '');
          if (msg === 'VOLUME_NOT_FOUND' && !cancelledDownloads.has(albumId)) {
            cancelledDownloads.add(albumId);
            showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
          }
          return { song, localPath: null as string | null, error: msg };
        }
      }),
    );

    const resultMap = new Map(results.map(r => [r.song.id, r]));
    jobStore.setState(state => ({
      jobs: state.jobs.map(j => {
        if (j.albumId !== albumId) return j;
        const r = resultMap.get(j.trackId);
        if (!r) return j;
        if (r.error === 'CANCELLED') return j;
        return { ...j, status: r.localPath ? 'done' : 'error' };
      }),
    }));
  }

  clearOfflineCancel({ downloadId }).catch(() => {});
  setTimeout(() => {
    jobStore.setState(state => ({
      jobs: state.jobs.filter(
        j => j.albumId !== albumId || (j.status !== 'done' && j.status !== 'error'),
      ),
    }));
  }, 2500);
}

interface OfflineState {
  /** Legacy shim — new pins use `localPlaybackStore` only. */
  albums: Record<string, OfflineAlbumMeta>;
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
    type?: 'album' | 'playlist' | 'artist' | 'track',
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
      albums: {},

      isDownloaded: (trackId, serverId) =>
        useLocalPlaybackStore.getState().isPinned(trackId, serverIndexKeyForOffline(serverId)),

      isAlbumDownloaded: (albumId, serverId) => {
        const indexKey = serverIndexKeyForOffline(serverId);
        const group = useLocalPlaybackStore.getState().listPinnedGroups(indexKey)
          .find(g => g.pinSource.sourceId === albumId);
        if (!group || group.trackIds.length === 0) return false;
        return group.trackIds.every(tid =>
          useLocalPlaybackStore.getState().isPinned(tid, indexKey),
        );
      },

      isAlbumDownloading: (albumId) => {
        const jobState = useOfflineJobStore.getState();
        return jobState.pinQueue.some(p => p.albumId === albumId)
          || jobState.jobs.some(
            j => j.albumId === albumId && (j.status === 'queued' || j.status === 'downloading'),
          );
      },

      getLocalUrl: (trackId, serverId) =>
        useLocalPlaybackStore.getState().getLocalUrl(trackId, serverIndexKeyForOffline(serverId), 'library'),

      clearAll: async (serverId) => {
        const indexKey = serverIndexKeyForOffline(serverId);
        const groups = useLocalPlaybackStore.getState().listPinnedGroups(indexKey);
        for (const group of groups) {
          await useLocalPlaybackStore.getState().removeEntriesByPinSource(
            indexKey,
            group.pinSource,
            getMediaDir(),
          );
        }
        set(state => {
          const albums = { ...state.albums };
          for (const key of Object.keys(albums)) {
            if (key.startsWith(`${serverId}:`) || key.startsWith(`${indexKey}:`)) {
              delete albums[key];
            }
          }
          return { albums };
        });
      },

      getAlbumProgress: (albumId) => {
        const albumJobs = useOfflineJobStore.getState().jobs.filter(j => j.albumId === albumId);
        if (albumJobs.length === 0) return null;
        const done = albumJobs.filter(j => j.status === 'done' || j.status === 'error').length;
        return { done, total: albumJobs.length };
      },

      downloadAlbum: async (albumId, albumName, albumArtist, coverArt, year, songs, serverId, type = 'album') => {
        enqueueOfflinePin({
          albumId,
          albumName,
          albumArtist,
          coverArt,
          year,
          songs,
          serverId,
          type,
        });
      },

      downloadPlaylist: async (playlistId, playlistName, coverArt, songs, serverId) => {
        if (isSmartPlaylistName(playlistName)) return;
        const seen = new Set<string>();
        const unique = songs.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
        await get().downloadAlbum(playlistId, playlistName, '', coverArt, undefined, unique, serverId, 'playlist');
      },

      downloadArtist: async (artistId, artistName, serverId) => {
        const jobStore = useOfflineJobStore;
        let albums: { id: string; name: string; artist: string; coverArt?: string; year?: number }[] = [];
        try {
          const res = await getArtist(artistId);
          albums = res.albums;
        } catch { return; }
        if (albums.length === 0) return;

        const offline = get();
        let doneCount = 0;
        const toEnqueue: OfflinePinTask[] = [];
        for (const album of albums) {
          if (isOfflinePinComplete(album.id, serverId)) {
            doneCount += 1;
            continue;
          }
          if (offline.isAlbumDownloading(album.id)) continue;
          try {
            const { songs } = await getAlbum(album.id);
            toEnqueue.push({
              albumId: album.id,
              albumName: album.name,
              albumArtist: album.artist || artistName,
              coverArt: album.coverArt,
              year: album.year,
              songs,
              serverId,
              type: 'artist',
              artistProgressGroupId: artistId,
            });
          } catch { /* skip failed album */ }
        }

        if (doneCount === albums.length) return;

        const existing = jobStore.getState().bulkProgress[artistId];
        jobStore.setState(state => ({
          bulkProgress: {
            ...state.bulkProgress,
            [artistId]: {
              done: existing && existing.done > doneCount ? existing.done : doneCount,
              total: albums.length,
            },
          },
        }));

        if (toEnqueue.length === 0) return;

        for (const task of toEnqueue) {
          enqueueOfflinePin(task);
        }

        setTimeout(() => {
          jobStore.setState(state => {
            const progress = state.bulkProgress[artistId];
            if (!progress || progress.done < progress.total) return state;
            const { [artistId]: _removed, ...rest } = state.bulkProgress;
            return { bulkProgress: rest };
          });
        }, 5000);
      },

      deleteAlbum: async (albumId, serverId) => {
        useOfflineJobStore.getState().cancelDownload(albumId);
        cancelledDownloads.delete(albumId);
        removeOfflinePinTask(albumId);
        const indexKey = serverIndexKeyForOffline(serverId);
        const album = get().albums[`${indexKey}:${albumId}`]
          ?? get().albums[`${serverId}:${albumId}`];
        const pinSource: PinSource = album
          ? { kind: album.type ?? 'album', sourceId: albumId, displayName: album.name }
          : { kind: 'album', sourceId: albumId };
        await useLocalPlaybackStore.getState().removeEntriesByPinSource(
          indexKey,
          pinSource,
          getMediaDir(),
        );
        set(state => {
          const albums = { ...state.albums };
          delete albums[`${indexKey}:${albumId}`];
          delete albums[`${serverId}:${albumId}`];
          return { albums };
        });
      },
    }),
    {
      name: 'psysonic-offline',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ albums: state.albums }),
    },
  ),
);

registerOfflinePinExecutor(runOfflinePinDownload);
