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
import {
  useOfflineJobStore,
  cancelledDownloads,
  isOfflineDownloadCancelled,
  offlineAlbumIdsMatch,
} from '@/features/offline/store/offlineJobStore';
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
  canonicalizeOfflinePinTask,
  registerOfflinePinExecutor,
  removeOfflinePinTask,
  type OfflinePinTask,
} from '@/features/offline/utils/offlinePinQueue';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

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

/** Runs one queued offline pin (all tracks for a single album / playlist). */
async function runOfflinePinDownload(task: OfflinePinTask): Promise<void> {
  task = canonicalizeOfflinePinTask(task, serverIndexKeyForOffline(task.serverId));
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
  if (isOfflineDownloadCancelled(albumId, serverId)) return;
  cancelledDownloads.delete(cancelKey);

  const CONCURRENCY = 8;
  const jobStore = useOfflineJobStore;
  const downloadId = `${serverId}-${albumId}-${Date.now()}`;
  const serverIndexKey = serverIndexKeyForOffline(serverId);
  const libraryServerId = librarySqlServerId(serverId);
  const pinSource: PinSource = { kind: type, sourceId: albumId, displayName: albumName };
  const mediaDir = getMediaDir();

  if (mediaDir) {
    const ok = await checkDirAccessible({ path: mediaDir }).catch(() => false);
    if (!ok) {
      showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
      return;
    }
  }

  const activeTrackIds = songs.map(song => song.id);

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
        trackIds: activeTrackIds,
        type,
      },
    },
  }));

  await libraryUpsertSongsFromApi(libraryServerId, songs).catch(() => {});

  const pendingSongs = pendingOfflinePinSongs(songs, serverId);
  if (pendingSongs.length === 0) {
    for (const song of songs) {
      const prev = findLocalPlaybackEntry(song.id, serverId);
      if (!prev) continue;
      useLocalPlaybackStore.getState().upsertEntry({
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

  for (let i = 0; i < pendingSongs.length; i += CONCURRENCY) {
    if (isOfflineDownloadCancelled(albumId, serverId)) {
      cancelledDownloads.delete(cancelKey);
      jobStore.setState(state => ({
        jobs: state.jobs.filter(j => j.albumId !== albumId || (j.serverId && j.serverId !== serverId)),
      }));
      clearOfflineCancel({ downloadId }).catch(() => {});
      return;
    }

    const activeBatch = canonicalizeOfflinePinTask({
      ...task,
      albumId,
      songs: pendingSongs.slice(i, i + CONCURRENCY),
    }, serverIndexKey);
    const batch = activeBatch.songs;
    const batchAlbumId = activeBatch.albumId;
    const batchPinSource: PinSource = {
      ...pinSource,
      sourceId: canonicalizeConfirmedNavidromeId(serverIndexKey, pinSource.sourceId),
    };
    const batchIds = new Set(batch.map(s => s.id));

    jobStore.setState(state => ({
      jobs: state.jobs.map(j =>
        j.albumId === albumId && (!j.serverId || j.serverId === serverId)
          ? {
            ...j,
            albumId: batchAlbumId,
            trackId: canonicalizeConfirmedNavidromeId(serverIndexKey, j.trackId),
            ...(batchIds.has(canonicalizeConfirmedNavidromeId(serverIndexKey, j.trackId))
              ? { status: 'downloading' as const }
              : {}),
          }
          : j
      ),
    }));

    const results = await Promise.all(
      batch.map(async song => {
        const suffix = song.suffix || 'mp3';
        if (isOfflineDownloadCancelled(batchAlbumId, serverId)) {
          return { song, localPath: null as string | null, error: 'CANCELLED' };
        }
        const existing = findLocalPlaybackEntry(song.id, serverId);
        if (
          existing?.tier === 'library'
          && localEntrySatisfiesOriginalRequirement(existing, serverId)
        ) {
          useLocalPlaybackStore.getState().upsertEntry({
            ...existing,
            serverIndexKey,
            pinSource: batchPinSource,
            suffix: existing.suffix || suffix,
          });
          return { song, localPath: existing.localPath, error: null as string | null };
        }
        try {
          const trackId = canonicalizeConfirmedNavidromeId(serverIndexKey, song.id);
          const res = await invoke<{
            path: string;
            size: number;
            layoutFingerprint: string;
            originalBytesVerified: boolean;
          }>(
            'download_track_local',
            {
              tier: 'library',
              trackId,
              serverIndexKey,
              libraryServerId,
              url: buildOriginalStreamUrlForServer(serverId, trackId),
              suffix,
              mediaDir,
              downloadId,
            },
          );
          if (isOfflineDownloadCancelled(batchAlbumId, serverId)) {
            await deleteMediaFile({ localPath: res.path, mediaDir }).catch(() => {});
            return { song, localPath: null as string | null, error: 'CANCELLED' };
          }
          useLocalPlaybackStore.getState().upsertEntry({
            serverIndexKey,
            trackId,
            localPath: res.path,
            sizeBytes: res.size,
            layoutFingerprint: res.layoutFingerprint,
            tier: 'library',
            pinSource: batchPinSource,
            suffix,
            originalBytesVerified: res.originalBytesVerified,
          });
          return {
            song: { ...song, id: trackId },
            localPath: res.path,
            error: null as string | null,
          };
        } catch (err) {
          const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : '');
          if (msg === 'VOLUME_NOT_FOUND' && !isOfflineDownloadCancelled(batchAlbumId, serverId)) {
            cancelledDownloads.add(cancelKey);
            showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
          }
          return { song, localPath: null as string | null, error: msg };
        }
      }),
    );

    const resultMap = new Map(results.map(r => [r.song.id, r]));
    jobStore.setState(state => ({
      jobs: state.jobs.map(j => {
        if (j.albumId !== batchAlbumId || (j.serverId && j.serverId !== serverId)) return j;
        const r = resultMap.get(j.trackId);
        if (!r) return j;
        if (r.error === 'CANCELLED') return j;
        return { ...j, status: r.localPath ? 'done' : 'error' };
      }),
    }));
  }

  clearOfflineCancel({ downloadId }).catch(() => {});
  const completedAlbumId = canonicalizeConfirmedNavidromeId(serverIndexKey, albumId);
  setTimeout(() => {
    jobStore.setState(state => ({
      jobs: state.jobs.filter(
        j => j.albumId !== completedAlbumId
          || (j.serverId && j.serverId !== serverId)
          || (j.status !== 'done' && j.status !== 'error'),
      ),
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
          .find(g => offlineAlbumIdsMatch(albumId, g.pinSource.sourceId, indexKey));
        if (!group || group.trackIds.length === 0) return false;
        return group.trackIds.every(tid =>
          useLocalPlaybackStore.getState().isPinned(tid, indexKey),
        );
      },

      isAlbumDownloading: (albumId, serverId) => {
        const jobState = useOfflineJobStore.getState();
        return jobState.pinQueue.some(p => offlineAlbumIdsMatch(albumId, p.albumId, p.serverId ?? serverId)
          && (!serverId || !p.serverId || p.serverId === serverId))
          || jobState.jobs.some(
            j => offlineAlbumIdsMatch(albumId, j.albumId, j.serverId ?? serverId)
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
          j => offlineAlbumIdsMatch(albumId, j.albumId, j.serverId ?? serverId)
            && (!serverId || !j.serverId || j.serverId === serverId),
        );
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
        useOfflineJobStore.getState().cancelDownload(albumId, serverId);
        removeOfflinePinTask(albumId, serverId);
        const indexKey = serverIndexKeyForOffline(serverId);
        const activeAlbumId = canonicalizeConfirmedNavidromeId(indexKey, albumId);
        const album = Object.values(get().albums).find(meta => (
          (meta.serverId === indexKey || meta.serverId === serverId)
          && offlineAlbumIdsMatch(activeAlbumId, meta.id, indexKey)
        ));
        const groups = useLocalPlaybackStore.getState().listPinnedGroups(indexKey)
          .filter(group => offlineAlbumIdsMatch(activeAlbumId, group.pinSource.sourceId, indexKey));
        if (groups.length > 0) {
          for (const group of groups) {
            await useLocalPlaybackStore.getState().removeEntriesByPinSource(
              indexKey,
              group.pinSource,
              getMediaDir(),
            );
          }
        } else if (album) {
          const pinSource: PinSource = {
            kind: album.type ?? 'album',
            sourceId: activeAlbumId,
            displayName: album.name,
          };
          await useLocalPlaybackStore.getState().removeEntriesByPinSource(indexKey, pinSource, getMediaDir());
        }
        set(state => {
          const albums = { ...state.albums };
          for (const [key, meta] of Object.entries(albums)) {
            if (
              (meta.serverId === indexKey || meta.serverId === serverId)
              && offlineAlbumIdsMatch(activeAlbumId, meta.id, indexKey)
            ) delete albums[key];
          }
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
