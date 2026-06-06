import { libraryUpsertSongsFromApi } from '../../api/library';
import { librarySqlServerId } from '../../api/coverCache';
import { getAlbum } from '../../api/subsonicLibrary';
import { getArtist } from '../../api/subsonicArtists';
import { getStarred } from '../../api/subsonicStarRating';
import { buildStreamUrl } from '../../api/subsonicStreamUrl';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import { cancelledDownloads, useOfflineJobStore } from '../../store/offlineJobStore';
import { useFavoritesOfflineSyncStore } from '../../store/favoritesOfflineSyncStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { getMediaDir } from '../media/mediaDir';
import { resolveIndexKey, serverIndexKeyForProfile } from '../server/serverIndexKey';
import { FAVORITES_OFFLINE_JOB_ID } from './favoritesOfflineConstants';
import {
  entryBelongsToServer,
  findFavoriteAutoEntry,
  hasLocalLibraryBytes,
  hasLocalFavoriteAutoBytes,
} from './offlineLibraryHelpers';

const CONCURRENCY = 2;
const DEBOUNCE_MS = 600;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let runToken = 0;

function serverIndexKeyForSync(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

function librarySqlScope(serverId: string): string {
  return librarySqlServerId(serverId);
}

/** Collect every starred track (direct songs + album/artist expansion). */
export async function collectStarredSongs(serverId: string): Promise<SubsonicSong[]> {
  const starred = await getStarred();
  const byId = new Map<string, SubsonicSong>();

  for (const song of starred.songs) {
    byId.set(song.id, song);
  }

  for (const album of starred.albums) {
    try {
      const detail = await getAlbum(album.id);
      for (const song of detail.songs) {
        byId.set(song.id, song);
      }
    } catch {
      // skip unavailable album
    }
  }

  for (const artist of starred.artists) {
    try {
      const detail = await getArtist(artist.id);
      for (const alb of detail.albums ?? []) {
        try {
          const albumDetail = await getAlbum(alb.id);
          for (const song of albumDetail.songs) {
            byId.set(song.id, song);
          }
        } catch {
          // skip album
        }
      }
    } catch {
      // skip unavailable artist
    }
  }

  return [...byId.values()];
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
    await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
    lp.removeEntry(entry.trackId, entry.serverIndexKey, 'favorite-unstar-prune');
  }
  await invoke('prune_empty_media_tier_dirs', { tier: 'favorite-auto', mediaDir }).catch(() => {});
}

export async function removeFavoriteAutoForTrack(trackId: string, serverId: string): Promise<void> {
  if (!serverId) return;
  const entry = findFavoriteAutoEntry(trackId, serverId);
  if (!entry) return;
  const mediaDir = getMediaDir();
  await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
  useLocalPlaybackStore.getState().removeEntry(entry.trackId, entry.serverIndexKey, 'favorite-unstar');
  useOfflineJobStore.setState(state => ({
    jobs: state.jobs.filter(j => !(j.albumId === FAVORITES_OFFLINE_JOB_ID && j.trackId === trackId)),
  }));
}

export async function disableFavoritesOfflineSync(): Promise<void> {
  runToken += 1;
  useAuthStore.getState().setFavoritesOfflineEnabled(false);
  cancelledDownloads.add(FAVORITES_OFFLINE_JOB_ID);
  const mediaDir = getMediaDir();
  await useLocalPlaybackStore.getState().purgeFavoriteAutoDisk(mediaDir);
  useOfflineJobStore.setState(state => ({
    jobs: state.jobs.filter(j => j.albumId !== FAVORITES_OFFLINE_JOB_ID),
  }));
  useFavoritesOfflineSyncStore.getState().setRunning(false);
  useFavoritesOfflineSyncStore.getState().setTargetTrackIds([]);
  useFavoritesOfflineSyncStore.getState().setLastError(null);
}

export function scheduleFavoritesOfflineSync(serverId?: string): void {
  if (!useAuthStore.getState().favoritesOfflineEnabled) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runFavoritesOfflineSync(serverId);
  }, DEBOUNCE_MS);
}

/** Called after any successful star/unstar (song, album, or artist) — not tied to the Favorites page. */
export function onFavoritesOfflineStarChange(
  id: string,
  type: 'song' | 'album' | 'artist',
  starred: boolean,
): void {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled || !auth.activeServerId) return;
  if (type === 'song' && !starred) {
    void removeFavoriteAutoForTrack(id, auth.activeServerId);
  }
  scheduleFavoritesOfflineSync(auth.activeServerId);
}

async function runFavoritesOfflineSync(explicitServerId?: string): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled) return;

  const serverId = explicitServerId || auth.activeServerId;
  if (!serverId) return;

  const token = ++runToken;
  const syncStore = useFavoritesOfflineSyncStore.getState();
  const jobStore = useOfflineJobStore;
  const lp = useLocalPlaybackStore.getState();
  const serverIndexKey = serverIndexKeyForSync(serverId);
  const libraryServerId = librarySqlScope(serverId);
  const mediaDir = getMediaDir();
  const downloadId = `favorites-${Date.now()}`;
  const albumName = i18n.t('favorites.offlineJobName');

  syncStore.setRunning(true);
  syncStore.setLastError(null);

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
        invoke('clear_offline_cancel', { downloadId }).catch(() => {});
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
              tier: 'favorite-auto',
              suffix,
            });
            return { song, error: null };
          } catch (err) {
            const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'error');
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
      await invoke('prune_empty_media_tier_dirs', { tier: 'favorite-auto', mediaDir }).catch(() => {});
    }
  } catch (err) {
    if (token === runToken) {
      const msg = err instanceof Error ? err.message : String(err);
      syncStore.setLastError(msg);
    }
  } finally {
    if (token === runToken) {
      syncStore.setRunning(false);
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
    if (
      state.favoritesOfflineEnabled !== prev.favoritesOfflineEnabled
      || state.activeServerId !== prev.activeServerId
    ) {
      runIfEnabled();
    }
  });
}
