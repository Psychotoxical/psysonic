import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { buildOriginalStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '@/store/authStore';
import { showToast } from '@/lib/dom/toast';
import { useOfflineJobStore, cancelledDownloads } from '@/features/offline/store/offlineJobStore';
import { useLocalPlaybackStore, type PinSource } from '@/store/localPlaybackStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { checkDirAccessible, clearOfflineCancel, deleteMediaFile } from '@/lib/api/syncfs';
import { findLocalPlaybackEntry } from '@/store/localPlaybackResolve';
import {
  isOfflinePinComplete,
  localEntrySatisfiesOriginalRequirement,
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
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import i18n from '@/lib/i18n';

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

function activeOfflineServerId(albumId: string, serverRef: string): string | null {
  const { jobs, pinQueue } = useOfflineJobStore.getState();
  const candidates = [
    ...pinQueue.filter(entry => entry.albumId === albumId).map(entry => entry.serverId),
    ...jobs.filter(job => job.albumId === albumId).map(job => job.serverId),
  ];
  return candidates.find(candidate => (
    candidate === serverRef
      || (candidate ? serverIndexKeyForOffline(candidate) === serverRef : false)
  )) ?? null;
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
  const cancelKey = `${serverId}:${albumId}`;
  if (cancelledDownloads.has(cancelKey)) return;
  cancelledDownloads.delete(cancelKey);

  const trackIds = songs.map(s => s.id);
  const jobStore = useOfflineJobStore;
  const downloadId = `${serverId}-${albumId}-${Date.now()}`;
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
      jobs: state.jobs.filter(j => j.albumId !== albumId || (j.serverId && j.serverId !== serverId)),
    }));
    return;
  }

  jobStore.setState(state => ({
    jobs: [
      ...state.jobs.filter(j => j.albumId !== albumId || (j.serverId && j.serverId !== serverId)),
      ...pendingSongs.map((s, i) => ({
        trackId: s.id,
        albumId,
        albumName,
        trackTitle: s.title,
        trackIndex: i,
        totalTracks: pendingSongs.length,
        status: 'queued' as const,
        downloadId,
        serverId,
      })),
    ],
  }));

  const finishCancelledDownload = () => {
    cancelledDownloads.delete(cancelKey);
    jobStore.setState(state => ({
      jobs: state.jobs.filter(j => j.albumId !== albumId || (j.serverId && j.serverId !== serverId)),
    }));
    clearOfflineCancel({ downloadId }).catch(() => {});
  };

  let failedTracks = 0;
  for (const song of pendingSongs) {
    if (cancelledDownloads.has(cancelKey)) {
      finishCancelledDownload();
      return;
    }

    jobStore.setState(state => ({
      jobs: state.jobs.map(j =>
        j.albumId === albumId
          && (!j.serverId || j.serverId === serverId)
          && j.trackId === song.id
          ? { ...j, status: 'downloading' }
          : j,
      ),
    }));

    const suffix = song.suffix || 'mp3';
    let localPath: string | null = null;
    let error: string | null = null;
    const existing = findLocalPlaybackEntry(song.id, serverId);
    if (
      existing?.tier === 'library'
      && localEntrySatisfiesOriginalRequirement(existing, serverId)
    ) {
      useLocalPlaybackStore.getState().upsertEntry({
        ...existing,
        serverIndexKey,
        pinSource,
        suffix: existing.suffix || suffix,
      });
      localPath = existing.localPath;
    } else {
      try {
        const res = await invoke<{
          path: string;
          size: number;
          layoutFingerprint: string;
          originalBytesVerified: boolean;
        }>(
          'download_track_local',
          {
            tier: 'library',
            trackId: song.id,
            serverIndexKey,
            libraryServerId,
            url: buildOriginalStreamUrlForServer(serverId, song.id),
            suffix,
            mediaDir,
            downloadId,
          },
        );
        if (cancelledDownloads.has(cancelKey)) {
          await deleteMediaFile({ localPath: res.path, mediaDir }).catch(() => {});
          error = 'CANCELLED';
        } else {
          useLocalPlaybackStore.getState().upsertEntry({
            serverIndexKey,
            trackId: song.id,
            localPath: res.path,
            sizeBytes: res.size,
            layoutFingerprint: res.layoutFingerprint,
            tier: 'library',
            pinSource,
            suffix,
            originalBytesVerified: res.originalBytesVerified,
          });
          localPath = res.path;
        }
      } catch (err) {
        error = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'error');
        if (error === 'VOLUME_NOT_FOUND' && !cancelledDownloads.has(cancelKey)) {
          cancelledDownloads.add(cancelKey);
          showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
        } else if (error !== 'CANCELLED') {
          console.error('[offline] track download failed', {
            serverId,
            albumId,
            trackId: song.id,
            error,
          });
        }
      }
    }

    if (error === 'CANCELLED') {
      finishCancelledDownload();
      return;
    }

    jobStore.setState(state => ({
      jobs: state.jobs.map(j =>
        j.albumId === albumId
          && (!j.serverId || j.serverId === serverId)
          && j.trackId === song.id
          ? { ...j, status: localPath ? 'done' : 'error' }
          : j,
      ),
    }));
    if (!localPath) failedTracks += 1;
    if (cancelledDownloads.has(cancelKey)) {
      finishCancelledDownload();
      return;
    }
  }

  clearOfflineCancel({ downloadId }).catch(() => {});
  if (failedTracks > 0) {
    showToast(i18n.t('albums.offlineFailed', { name: albumName }), 6000, 'error');
  }
  setTimeout(() => {
    jobStore.setState(state => ({
      jobs: state.jobs.filter(j => (
        j.downloadId !== downloadId || (j.status !== 'done' && j.status !== 'error')
      )),
    }));
  }, 2500);
}

interface OfflineState {
  /** Legacy shim — new pins use `localPlaybackStore` only. */
  albums: Record<string, OfflineAlbumMeta>;
  isDownloaded: (trackId: string, serverId: string) => boolean;
  isAlbumDownloaded: (albumId: string, serverId: string) => boolean;
  isAlbumDownloading: (albumId: string, serverId?: string) => boolean;
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
  getAlbumProgress: (albumId: string, serverId?: string) => { done: number; total: number } | null;
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

      isAlbumDownloading: (albumId, serverId) => {
        const jobState = useOfflineJobStore.getState();
        return jobState.pinQueue.some(p => p.albumId === albumId && (!serverId || !p.serverId || p.serverId === serverId))
          || jobState.jobs.some(
            j => j.albumId === albumId
              && (!serverId || !j.serverId || j.serverId === serverId)
              && (j.status === 'queued' || j.status === 'downloading'),
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

      getAlbumProgress: (albumId, serverId) => {
        const albumJobs = useOfflineJobStore.getState().jobs.filter(
          j => j.albumId === albumId && (!serverId || !j.serverId || j.serverId === serverId),
        );
        if (albumJobs.length === 0) return null;
        const done = albumJobs.filter(j => j.status === 'done').length;
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
        const progressKey = ownedEntityKey({ id: artistId, serverId });
        let albums: { id: string; name: string; artist: string; coverArt?: string; year?: number }[] = [];
        try {
          const res = await getArtistForServer(serverId, artistId);
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
          if (offline.isAlbumDownloading(album.id, serverId)) continue;
          try {
            const { songs } = await getAlbumForServer(serverId, album.id);
            toEnqueue.push({
              albumId: album.id,
              albumName: album.name,
              albumArtist: album.artist || artistName,
              coverArt: album.coverArt,
              year: album.year,
              songs,
              serverId,
              type: 'artist',
              artistProgressGroupId: progressKey,
            });
          } catch { /* skip failed album */ }
        }

        if (doneCount === albums.length) return;

        const existing = jobStore.getState().bulkProgress[progressKey];
        jobStore.setState(state => ({
          bulkProgress: {
            ...state.bulkProgress,
            [progressKey]: {
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
            const progress = state.bulkProgress[progressKey];
            if (!progress || progress.done < progress.total) return state;
            const { [progressKey]: _removed, ...rest } = state.bulkProgress;
            return { bulkProgress: rest };
          });
        }, 5000);
      },

      deleteAlbum: async (albumId, serverId) => {
        const jobServerId = activeOfflineServerId(albumId, serverId) ?? serverId;
        useOfflineJobStore.getState().cancelDownload(albumId, jobServerId);
        removeOfflinePinTask(albumId, jobServerId);
        const indexKey = serverIndexKeyForOffline(jobServerId);
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
