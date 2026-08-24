import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import { getStarredForServer } from '@/lib/api/subsonicStarRating';
import { buildOriginalStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/lib/i18n';
import { serverSupportsRawStream, useAuthStore } from '@/store/authStore';
import {
  cancelledDownloads,
  markOfflineDownloadCancelled,
  useOfflineJobStore,
} from '@/features/offline/store/offlineJobStore';
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
  findFavoriteAutoEntry,
  findLocalPlaybackEntry,
  hasLocalLibraryBytes,
} from '@/store/localPlaybackResolve';
import {
  beginOfflineTrackTransfer,
  runOfflineTrackDeletionBatch,
  runOfflineTrackCleanup,
  waitForOfflineTrackDeletion,
} from '@/features/offline/utils/offlineOperationCoordinator';

const CONCURRENCY = 2;
const DEBOUNCE_MS = 600;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Accumulates server ids across debounced calls; `'all'` means fan-out to every server. */
let pendingSyncServerIds: Set<string> | 'all' = new Set();
let runToken = 0;
/** Rust cancellation key for the active favorites batch (`download_track_local`). */
let activeFavoritesDownloadId: string | null = null;
let favoritesDownloadSequence = 0;
const pendingFavoritesCancelRequests = new Map<string, Promise<void>>();

function nextFavoritesDownloadId(): string {
  favoritesDownloadSequence += 1;
  return `favorites-${Date.now()}-${favoritesDownloadSequence}`;
}

function rustDownloadIdsForFavoritesJobs(): string[] {
  const fromJobs = useOfflineJobStore
    .getState()
    .jobs.filter(j => j.albumId === FAVORITES_OFFLINE_JOB_ID && j.downloadId)
    .map(j => j.downloadId);
  const ids = new Set(fromJobs);
  if (activeFavoritesDownloadId) ids.add(activeFavoritesDownloadId);
  return [...ids];
}

function requestFavoritesDownloadCancellation(downloadIds: string[]): void {
  if (downloadIds.length === 0) return;
  const request = cancelOfflineDownloads({ downloadIds }).catch(() => {});
  for (const downloadId of downloadIds) {
    const previous = pendingFavoritesCancelRequests.get(downloadId);
    const pending = previous
      ? Promise.all([previous, request]).then(() => {})
      : request;
    pendingFavoritesCancelRequests.set(downloadId, pending);
  }
}

async function finishFavoritesDownloadCancellation(downloadId: string): Promise<void> {
  while (true) {
    const pending = pendingFavoritesCancelRequests.get(downloadId);
    if (pending) await pending;
    if (pendingFavoritesCancelRequests.get(downloadId) !== pending) continue;
    if (pending) pendingFavoritesCancelRequests.delete(downloadId);

    await clearOfflineCancel({ downloadId }).catch(() => {});
    if (!pendingFavoritesCancelRequests.has(downloadId)) return;
  }
}

/** Abort in-flight favorites transfers and invalidate the current JS batch loop. */
function cancelInFlightFavoritesDownloads(): void {
  runToken += 1;
  markOfflineDownloadCancelled(FAVORITES_OFFLINE_JOB_ID);
  const downloadIds = rustDownloadIdsForFavoritesJobs();
  requestFavoritesDownloadCancellation(downloadIds);
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
  return songs.filter((song) => {
    if (hasLocalLibraryBytes(song.id, serverId)) return false;
    const existing = findFavoriteAutoEntry(song.id, serverId);
    if (!existing?.localPath) return true;
    return serverSupportsRawStream(serverId) && existing.originalBytesVerified !== true;
  });
}

async function pruneOrphanFavoriteAuto(
  serverId: string,
  targetIds: Set<string>,
  mediaDir: string | null,
  token: number,
): Promise<void> {
  const entries = Object.values(useLocalPlaybackStore.getState().entries);
  for (const entry of entries) {
    if (token !== runToken) return;
    if (entry.tier !== 'favorite-auto') continue;
    if (!entryBelongsToServer(entry, serverId)) continue;
    if (targetIds.has(entry.trackId)) continue;
    await runOfflineTrackDeletionBatch(
      [{ serverIndexKey: entry.serverIndexKey, trackId: entry.trackId }],
      async () => {
        if (token !== runToken) return;
        const current = useLocalPlaybackStore.getState().getEntry(
          entry.trackId,
          entry.serverIndexKey,
        );
        if (
          !current
          || current.tier !== 'favorite-auto'
          || !entryBelongsToServer(current, serverId)
          || targetIds.has(current.trackId)
        ) return;
        await deleteMediaFile({ localPath: current.localPath, mediaDir }).catch(() => {});
        const latest = useLocalPlaybackStore.getState().getEntry(
          current.trackId,
          current.serverIndexKey,
        );
        if (latest?.localPath === current.localPath && latest.tier === 'favorite-auto') {
          useLocalPlaybackStore.getState().removeEntry(
            current.trackId,
            current.serverIndexKey,
            'favorite-unstar-prune',
          );
        }
      },
    );
  }
  if (token === runToken) {
    await pruneEmptyMediaTierDirs({ tier: 'favorite-auto', mediaDir }).catch(() => {});
  }
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
  let downloadId: string | null = null;

  try {
    const allSongs = await collectStarredSongs(serverId);
    if (token !== runToken) return;

    const targetIds = new Set(allSongs.map(s => s.id));
    syncStore.setTargetTrackIds([...targetIds]);

    await pruneOrphanFavoriteAuto(serverId, targetIds, mediaDir, token);
    if (token !== runToken) return;

    await libraryUpsertSongsFromApi(libraryServerId, allSongs).catch(() => {});
    if (token !== runToken) return;
    await Promise.all(allSongs.map(song => waitForOfflineTrackDeletion(
      serverIndexKey,
      song.id,
    )));
    if (token !== runToken) return;

    const pending = pendingFavoriteAutoSongs(allSongs, serverId);
    if (pending.length === 0) {
      if (token === runToken) {
        jobStore.setState(state => ({
          jobs: state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
        }));
      }
      return;
    }

    if (token !== runToken) return;

    cancelledDownloads.delete(FAVORITES_OFFLINE_JOB_ID);
    const currentDownloadId = nextFavoritesDownloadId();
    downloadId = currentDownloadId;
    activeFavoritesDownloadId = currentDownloadId;

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
          downloadId: currentDownloadId,
        })),
      ],
    }));

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      if (token !== runToken || cancelledDownloads.has(FAVORITES_OFFLINE_JOB_ID)) {
        if (token === runToken) cancelledDownloads.delete(FAVORITES_OFFLINE_JOB_ID);
        jobStore.setState(state => ({
          jobs: state.jobs.filter(j => j.downloadId !== currentDownloadId),
        }));
        requestFavoritesDownloadCancellation([currentDownloadId]);
        return;
      }

      const batch = pending.slice(i, i + CONCURRENCY);
      const batchIds = new Set(batch.map(s => s.id));

      jobStore.setState(state => ({
        jobs: state.jobs.map(j =>
          j.downloadId === currentDownloadId && batchIds.has(j.trackId)
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
          const existingFavorite = findFavoriteAutoEntry(song.id, serverId);
          if (
            hasLocalLibraryBytes(song.id, serverId)
            || (
              existingFavorite?.localPath
              && (!serverSupportsRawStream(serverId) || existingFavorite.originalBytesVerified === true)
            )
          ) {
            return { song, error: null };
          }
          const finishTrackTransfer = await beginOfflineTrackTransfer(serverIndexKey, song.id);
          try {
            const res = await invoke<{
              path: string;
              size: number;
              layoutFingerprint: string;
              originalBytesVerified: boolean;
            }>(
              'download_track_local',
              {
                tier: 'favorite-auto',
                trackId: song.id,
                serverIndexKey,
                libraryServerId,
                url: buildOriginalStreamUrlForServer(serverId, song.id),
                suffix,
                mediaDir,
                downloadId: currentDownloadId,
              },
            );
            if (
              token !== runToken
              || cancelledDownloads.has(FAVORITES_OFFLINE_JOB_ID)
              || !targetIds.has(song.id)
            ) {
              finishTrackTransfer();
              await runOfflineTrackCleanup(serverIndexKey, song.id, async () => {
                if (findLocalPlaybackEntry(song.id, serverId)?.localPath === res.path) return;
                await deleteMediaFile({ localPath: res.path, mediaDir }).catch(() => {});
              });
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
              originalBytesVerified: res.originalBytesVerified,
            });
            return { song, error: null };
          } catch (err) {
            const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'error');
            if (msg === 'CANCELLED') return { song, error: 'CANCELLED' };
            return { song, error: msg };
          } finally {
            finishTrackTransfer();
          }
        }),
      ).then(results => {
        jobStore.setState(state => ({
          jobs: state.jobs.map(j => {
            if (j.downloadId !== currentDownloadId) return j;
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
          j => j.downloadId !== currentDownloadId || (j.status !== 'done' && j.status !== 'error'),
        ),
      }));
      await pruneEmptyMediaTierDirs({ tier: 'favorite-auto', mediaDir }).catch(() => {});
    }
  } catch (err) {
    if (token === runToken) {
      const msg = err instanceof Error ? err.message : String(err);
      syncStore.setLastError(msg);
    }
  } finally {
    if (downloadId) {
      await finishFavoritesDownloadCancellation(downloadId);
      if (activeFavoritesDownloadId === downloadId) activeFavoritesDownloadId = null;
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
  const unsubscribe = useAuthStore.subscribe((state, prev) => {
    if (state.favoritesOfflineEnabled && !prev.favoritesOfflineEnabled) {
      runIfEnabled();
    }
  });
  return () => {
    unsubscribe();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingSyncServerIds = new Set();
    cancelInFlightFavoritesDownloads();
  };
}
