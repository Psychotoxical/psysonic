import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import { getStarredForServer } from '@/lib/api/subsonicStarRating';
import { buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/lib/i18n';
import { useAuthStore } from '@/store/authStore';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { useFavoritesOfflineSyncStore } from '@/features/offline/store/favoritesOfflineSyncStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import {
  cancelOfflineDownloads,
  clearOfflineCancel,
  deleteMediaFile,
  pruneEmptyMediaTierDirs,
} from '@/lib/api/syncfs';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { FAVORITES_OFFLINE_JOB_ID } from '@/features/offline/utils/favoritesOfflineConstants';
import { isActiveServerReachable } from '@/lib/network/activeServerReachability';
import { favoritesServerIds } from '@/features/offline/utils/favoritesOfflineBrowse';
import { loadAlbumFromLibraryIndex } from '@/features/offline/utils/offlineLibraryIndexLoad';
import {
  entryBelongsToServer,
  hasLocalLibraryBytes,
  hasLocalFavoriteAutoBytes,
} from '@/store/localPlaybackResolve';

const CONCURRENCY = 2;
const DEBOUNCE_MS = 600;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Accumulates server ids across debounced calls; `'all'` means fan-out to every server. */
let pendingSyncServerIds: Set<string> | 'all' = new Set();
let runToken = 0;
/** Rust cancellation key for the active favorites batch (`download_track_local`). */
let activeFavoritesDownloadId: string | null = null;

function rustDownloadIdsForFavoritesJobs(): string[] {
  const fromJobs = useOfflineJobStore
    .getState()
    .jobs.filter(j => j.albumId === FAVORITES_OFFLINE_JOB_ID && j.downloadId)
    .map(j => j.downloadId);
  const ids = new Set(fromJobs);
  if (activeFavoritesDownloadId) ids.add(activeFavoritesDownloadId);
  return [...ids];
}

/** Abort in-flight favorites transfers and invalidate the current JS batch loop. */
function cancelInFlightFavoritesDownloads(): void {
  runToken += 1;
  cancelledDownloads.add(FAVORITES_OFFLINE_JOB_ID);
  const downloadIds = rustDownloadIdsForFavoritesJobs();
  if (downloadIds.length > 0) {
    cancelOfflineDownloads({ downloadIds }).catch(() => {});
    for (const id of downloadIds) {
      clearOfflineCancel({ downloadId: id }).catch(() => {});
    }
  }
  activeFavoritesDownloadId = null;
  useOfflineJobStore.setState(state => ({
    jobs: state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
  }));
  useFavoritesOfflineSyncStore.getState().setRunning(false);
}

function serverIndexKeyForSync(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

function librarySqlScope(serverId: string): string {
  return librarySqlServerId(serverId);
}

/**
 * Union of all tracks implied by starred songs, albums, and artists (deduped by track id).
 * File/index lifecycle keys off this set — never per-entity pin — so overlapping stars
 * (artist + song on the same album) share one `favorite-auto` row per track.
 */
export function mergeStarredSongsUnion(
  directSongs: SubsonicSong[],
  albumTrackLists: SubsonicSong[][],
  artistAlbumTrackLists: SubsonicSong[][],
): SubsonicSong[] {
  const byId = new Map<string, SubsonicSong>();
  for (const song of directSongs) byId.set(song.id, song);
  for (const songs of albumTrackLists) {
    for (const song of songs) byId.set(song.id, song);
  }
  for (const songs of artistAlbumTrackLists) {
    for (const song of songs) byId.set(song.id, song);
  }
  return [...byId.values()];
}

/** Collect every starred track (direct songs + album/artist expansion) for one server. */
export async function collectStarredSongs(serverId: string): Promise<SubsonicSong[]> {
  const starred = await getStarredForServer(serverId);
  const albumTrackLists: SubsonicSong[][] = [];
  for (const album of starred.albums) {
    try {
      const detail = await getAlbumForServer(serverId, album.id);
      albumTrackLists.push(detail.songs);
    } catch {
      try {
        const local = await loadAlbumFromLibraryIndex(serverId, album.id);
        if (local) albumTrackLists.push(local.songs);
      } catch {
        // skip unavailable album
      }
    }
  }

  const artistAlbumTrackLists: SubsonicSong[][] = [];
  for (const artist of starred.artists) {
    try {
      const detail = await getArtistForServer(serverId, artist.id);
      for (const alb of detail.albums ?? []) {
        try {
          const albumDetail = await getAlbumForServer(serverId, alb.id);
          artistAlbumTrackLists.push(albumDetail.songs);
        } catch {
          try {
            const local = await loadAlbumFromLibraryIndex(serverId, alb.id);
            if (local) artistAlbumTrackLists.push(local.songs);
          } catch {
            // skip album
          }
        }
      }
    } catch {
      // skip unavailable artist
    }
  }

  return mergeStarredSongsUnion(starred.songs, albumTrackLists, artistAlbumTrackLists);
}

function pendingFavoriteAutoSongs(songs: SubsonicSong[], serverId: string): SubsonicSong[] {
  return songs.filter(s => !hasLocalLibraryBytes(s.id, serverId) && !hasLocalFavoriteAutoBytes(s.id, serverId));
}

async function pruneOrphanFavoriteAuto(
  serverId: string,
  targetIds: Set<string>,
  mediaDir: string | null,
): Promise<void> {
  const lp = useLocalPlaybackStore.getState();
  for (const entry of Object.values(lp.entries)) {
    if (entry.tier !== 'favorite-auto') continue;
    if (!entryBelongsToServer(entry, serverId)) continue;
    if (targetIds.has(entry.trackId)) continue;
    await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
    lp.removeEntry(entry.trackId, entry.serverIndexKey, 'favorite-unstar-prune');
  }
  await pruneEmptyMediaTierDirs({ tier: 'favorite-auto', mediaDir }).catch(() => {});
}

export async function disableFavoritesOfflineSync(): Promise<void> {
  useAuthStore.getState().setFavoritesOfflineEnabled(false);
  cancelInFlightFavoritesDownloads();
  const mediaDir = getMediaDir();
  await useLocalPlaybackStore.getState().purgeFavoriteAutoDisk(mediaDir);
  useFavoritesOfflineSyncStore.getState().setTargetTrackIds([]);
  useFavoritesOfflineSyncStore.getState().setLastError(null);
}

export function scheduleFavoritesOfflineSync(serverId?: string): void {
  if (!useAuthStore.getState().favoritesOfflineEnabled) return;
  if (!isActiveServerReachable()) return;
  cancelInFlightFavoritesDownloads();
  if (serverId) {
    if (pendingSyncServerIds !== 'all') {
      pendingSyncServerIds.add(serverId);
    }
  } else {
    pendingSyncServerIds = 'all';
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const serverIds = pendingSyncServerIds === 'all'
      ? favoritesServerIds()
      : [...pendingSyncServerIds];
    pendingSyncServerIds = new Set();
    void runFavoritesOfflineSyncBatch(serverIds);
  }, DEBOUNCE_MS);
}

/**
 * Called after any successful star/unstar (song, album, or artist).
 * Deletions run only inside {@link runFavoritesOfflineSync} via {@link pruneOrphanFavoriteAuto}
 * against the merged track union — never eager per-entity removes (avoids deleting a file
 * that is still required because the same track is starred via artist/album).
 */
export function onFavoritesOfflineStarChange(
  _id: string,
  _type: 'song' | 'album' | 'artist',
  _starred: boolean,
  serverId?: string,
): void {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled) return;
  const target = serverId ?? auth.activeServerId;
  if (!target) return;
  scheduleFavoritesOfflineSync(target);
}

async function runFavoritesOfflineSyncBatch(serverIds: string[]): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled || serverIds.length === 0) return;

  const token = ++runToken;
  const syncStore = useFavoritesOfflineSyncStore.getState();
  syncStore.setRunning(true);
  syncStore.setLastError(null);

  try {
    for (const serverId of serverIds) {
      if (token !== runToken) return;
      await runFavoritesOfflineSyncOneServer(serverId, token);
    }
  } finally {
    if (token === runToken) {
      syncStore.setRunning(false);
    }
  }
}

async function runFavoritesOfflineSyncOneServer(serverId: string, token: number): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled) return;
  const syncStore = useFavoritesOfflineSyncStore.getState();
  const jobStore = useOfflineJobStore;
  const serverIndexKey = serverIndexKeyForSync(serverId);
  const libraryServerId = librarySqlScope(serverId);
  const mediaDir = getMediaDir();
  const albumName = i18n.t('favorites.offlineJobName');

  try {
    const allSongs = await collectStarredSongs(serverId);
    if (token !== runToken) return;

    const targetIds = new Set(allSongs.map(s => s.id));
    syncStore.setTargetTrackIds([...targetIds]);

    await pruneOrphanFavoriteAuto(serverId, targetIds, mediaDir);
    if (token !== runToken) return;

    await libraryUpsertSongsFromApi(libraryServerId, allSongs).catch(() => {});

    const pending = pendingFavoriteAutoSongs(allSongs, serverId);
    if (pending.length === 0) {
      jobStore.setState(state => ({
        jobs: state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
      }));
      return;
    }

    if (token !== runToken) return;

    cancelledDownloads.delete(FAVORITES_OFFLINE_JOB_ID);
    const downloadId = `favorites-${Date.now()}`;
    activeFavoritesDownloadId = downloadId;

    jobStore.setState(state => ({
      jobs: [
        ...state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
        ...pending.map((s, i) => ({
          trackId: s.id,
          albumId: FAVORITES_OFFLINE_JOB_ID,
          albumName,
          trackTitle: s.title,
          trackIndex: i,
          totalTracks: pending.length,
          status: 'queued' as const,
          downloadId,
        })),
      ],
    }));

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      if (token !== runToken || cancelledDownloads.has(FAVORITES_OFFLINE_JOB_ID)) {
        cancelledDownloads.delete(FAVORITES_OFFLINE_JOB_ID);
        jobStore.setState(state => ({
          jobs: state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
        }));
        cancelOfflineDownloads({ downloadIds: [downloadId] }).catch(() => {});
        clearOfflineCancel({ downloadId }).catch(() => {});
        activeFavoritesDownloadId = null;
        return;
      }

      const batch = pending.slice(i, i + CONCURRENCY);
      const batchIds = new Set(batch.map(s => s.id));

      jobStore.setState(state => ({
        jobs: state.jobs.map(j =>
          j.albumId === FAVORITES_OFFLINE_JOB_ID && batchIds.has(j.trackId)
            ? { ...j, status: 'downloading' }
            : j,
        ),
      }));

      await Promise.all(
        batch.map(async song => {
          const suffix = song.suffix || 'mp3';
          if (cancelledDownloads.has(FAVORITES_OFFLINE_JOB_ID)) {
            return { song, error: 'CANCELLED' };
          }
          if (hasLocalLibraryBytes(song.id, serverId) || hasLocalFavoriteAutoBytes(song.id, serverId)) {
            return { song, error: null };
          }
          try {
            const res = await invoke<{ path: string; size: number; layoutFingerprint: string }>(
              'download_track_local',
              {
                tier: 'favorite-auto',
                trackId: song.id,
                serverIndexKey,
                libraryServerId,
                url: buildStreamUrlForServer(serverId, song.id),
                suffix,
                mediaDir,
                downloadId,
              },
            );
            if (
              token !== runToken
              || cancelledDownloads.has(FAVORITES_OFFLINE_JOB_ID)
              || !targetIds.has(song.id)
            ) {
              await deleteMediaFile({ localPath: res.path, mediaDir }).catch(() => {});
              return { song, error: 'CANCELLED' };
            }
            useLocalPlaybackStore.getState().upsertEntry({
              serverIndexKey,
              trackId: song.id,
              localPath: res.path,
              sizeBytes: res.size,
              layoutFingerprint: res.layoutFingerprint,
              tier: 'favorite-auto',
              suffix,
            });
            return { song, error: null };
          } catch (err) {
            const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'error');
            if (msg === 'CANCELLED') return { song, error: 'CANCELLED' };
            return { song, error: msg };
          }
        }),
      ).then(results => {
        jobStore.setState(state => ({
          jobs: state.jobs.map(j => {
            if (j.albumId !== FAVORITES_OFFLINE_JOB_ID) return j;
            const hit = results.find(r => r.song.id === j.trackId);
            if (!hit) return j;
            if (hit.error === 'CANCELLED') return j;
            return {
              ...j,
              status: hit.error ? ('error' as const) : ('done' as const),
            };
          }),
        }));
      });
    }

    if (token === runToken) {
      jobStore.setState(state => ({
        jobs: state.jobs.filter(
          j => j.albumId !== FAVORITES_OFFLINE_JOB_ID || (j.status !== 'done' && j.status !== 'error'),
        ),
      }));
      if (activeFavoritesDownloadId === downloadId) {
        clearOfflineCancel({ downloadId }).catch(() => {});
        activeFavoritesDownloadId = null;
      }
      await pruneEmptyMediaTierDirs({ tier: 'favorite-auto', mediaDir }).catch(() => {});
    }
  } catch (err) {
    if (token === runToken) {
      const msg = err instanceof Error ? err.message : String(err);
      syncStore.setLastError(msg);
    }
  }
}

/** Run an initial sync when the setting is enabled (app start / server change). */
export function initFavoritesOfflineSync(): () => void {
  const runIfEnabled = () => {
    if (useAuthStore.getState().favoritesOfflineEnabled) {
      scheduleFavoritesOfflineSync();
    }
  };
  runIfEnabled();
  return useAuthStore.subscribe((state, prev) => {
    if (state.favoritesOfflineEnabled && !prev.favoritesOfflineEnabled) {
      runIfEnabled();
    }
  });
}
