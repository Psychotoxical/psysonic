import { getPlaylist } from '../../api/subsonicPlaylists';
import { filterSongsToServerLibrary } from '../../api/subsonicLibrary';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore } from '../../store/offlineStore';
import { usePlaylistStore } from '../../store/playlistStore';
import { isSmartPlaylistName } from '../componentHelpers/playlistDetailHelpers';
import { getMediaDir } from '../media/mediaDir';
import {
  isActiveServerReachable,
  onActiveServerBecameReachable,
} from '../network/activeServerReachability';
import { resolveIndexKey, serverIndexKeyForProfile } from '../server/serverIndexKey';
import { resolveServerIdForIndexKey } from '../server/serverLookup';
import { findLocalPlaybackEntry } from './offlineLibraryHelpers';
import { enqueueOfflinePin } from './offlinePinQueue';

const DEBOUNCE_MS = 600;
const RETRY_WHILE_DOWNLOADING_MS = 2500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPlaylistIds = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function serverIndexKeyForOffline(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

function offlinePlaylistMeta(playlistId: string, serverId: string) {
  const indexKey = serverIndexKeyForOffline(serverId);
  const albums = useOfflineStore.getState().albums;
  return albums[`${indexKey}:${playlistId}`] ?? albums[`${serverId}:${playlistId}`];
}

function resolvePlaylistName(playlistId: string, serverId: string): string | undefined {
  return offlinePlaylistMeta(playlistId, serverId)?.name
    ?? usePlaylistStore.getState().playlists.find(p => p.id === playlistId)?.name;
}

/** Smart playlists refresh from server rules — not eligible for manual offline cache/sync. */
export function isManualOfflinePlaylist(playlistId: string, serverId: string, name?: string): boolean {
  const resolved = name ?? resolvePlaylistName(playlistId, serverId);
  return !resolved || !isSmartPlaylistName(resolved);
}

/** True when this playlist was cached offline (manual pin). */
export function isPlaylistPinnedOffline(playlistId: string, serverId: string): boolean {
  const meta = offlinePlaylistMeta(playlistId, serverId);
  if (meta?.type === 'playlist') return true;

  const indexKey = serverIndexKeyForOffline(serverId);
  const group = useLocalPlaybackStore.getState()
    .listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === 'playlist' && g.pinSource.sourceId === playlistId);
  return (group?.trackIds.length ?? 0) > 0;
}

function trackStillNeededByOtherPinnedPlaylist(
  trackId: string,
  serverIndexKey: string,
  exceptPlaylistId: string,
): boolean {
  for (const group of useLocalPlaybackStore.getState().listPinnedGroups(serverIndexKey)) {
    if (group.pinSource.kind !== 'playlist') continue;
    if (group.pinSource.sourceId === exceptPlaylistId) continue;
    if (group.trackIds.includes(trackId)) return true;
  }
  return false;
}

async function pruneRemovedPlaylistTracks(
  playlistId: string,
  serverId: string,
  keepIds: Set<string>,
): Promise<void> {
  const indexKey = serverIndexKeyForOffline(serverId);
  const lp = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const group = lp.listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === 'playlist' && g.pinSource.sourceId === playlistId);
  const previousIds = group?.trackIds ?? offlinePlaylistMeta(playlistId, serverId)?.trackIds ?? [];

  for (const trackId of previousIds) {
    if (keepIds.has(trackId)) continue;
    if (trackStillNeededByOtherPinnedPlaylist(trackId, indexKey, playlistId)) continue;

    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (!entry?.localPath || entry.tier !== 'library') continue;
    if (entry.pinSource?.kind !== 'playlist' || entry.pinSource.sourceId !== playlistId) continue;

    await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
    lp.removeEntry(trackId, entry.serverIndexKey, 'playlist-sync-prune');
  }
}

function dedupeSongs(songs: SubsonicSong[]): SubsonicSong[] {
  const seen = new Set<string>();
  return songs.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

function updateOfflinePlaylistMeta(
  playlistId: string,
  serverId: string,
  name: string,
  coverArt: string | undefined,
  trackIds: string[],
): void {
  const indexKey = serverIndexKeyForOffline(serverId);
  useOfflineStore.setState(state => {
    const key = `${indexKey}:${playlistId}`;
    const legacyKey = `${serverId}:${playlistId}`;
    const existing = state.albums[key] ?? state.albums[legacyKey];
    if (!existing) return state;
    const nextAlbums = { ...state.albums };
    delete nextAlbums[legacyKey];
    nextAlbums[key] = {
      ...existing,
      id: playlistId,
      serverId: indexKey,
      name,
      coverArt: coverArt ?? existing.coverArt,
      trackIds,
      type: 'playlist',
    };
    return { albums: nextAlbums };
  });
}

function scheduleRetryWhileDownloading(playlistId: string, serverId: string): void {
  const key = `${serverId}:${playlistId}`;
  const prev = retryTimers.get(key);
  if (prev) clearTimeout(prev);
  retryTimers.set(key, setTimeout(() => {
    retryTimers.delete(key);
    void syncPinnedPlaylistIfNeeded(playlistId, serverId);
  }, RETRY_WHILE_DOWNLOADING_MS));
}

/**
 * Refresh a manually cached playlist: download new tracks, drop removed ones,
 * update persisted offline metadata.
 */
export async function syncPinnedPlaylistIfNeeded(
  playlistId: string,
  serverId?: string,
  prefetchedSongs?: SubsonicSong[],
): Promise<void> {
  if (!isActiveServerReachable()) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !isPlaylistPinnedOffline(playlistId, sid)) return;
  if (!isManualOfflinePlaylist(playlistId, sid)) return;

  let songs = prefetchedSongs;
  let playlistName = offlinePlaylistMeta(playlistId, sid)?.name ?? playlistId;
  let coverArt = offlinePlaylistMeta(playlistId, sid)?.coverArt;

  if (!songs) {
    try {
      const data = await getPlaylist(playlistId);
      playlistName = data.playlist.name;
      coverArt = data.playlist.coverArt ?? coverArt;
      songs = await filterSongsToServerLibrary(data.songs, sid);
    } catch {
      return;
    }
  } else {
    songs = await filterSongsToServerLibrary(songs, sid);
  }

  const unique = dedupeSongs(songs);
  const keepIds = new Set(unique.map(s => s.id));

  await pruneRemovedPlaylistTracks(playlistId, sid, keepIds);
  updateOfflinePlaylistMeta(playlistId, sid, playlistName, coverArt, unique.map(s => s.id));

  const offline = useOfflineStore.getState();
  if (offline.isAlbumDownloading(playlistId)) {
    scheduleRetryWhileDownloading(playlistId, sid);
    return;
  }

  const enqueued = enqueueOfflinePin({
    albumId: playlistId,
    albumName: playlistName,
    albumArtist: '',
    coverArt,
    year: undefined,
    songs: unique,
    serverId: sid,
    type: 'playlist',
  });
  if (!enqueued && offline.isAlbumDownloading(playlistId)) {
    scheduleRetryWhileDownloading(playlistId, sid);
  }
}

export function schedulePinnedPlaylistSync(
  playlistId: string,
  serverId?: string,
): void {
  if (!playlistId) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !isPlaylistPinnedOffline(playlistId, sid)) return;
  if (!isManualOfflinePlaylist(playlistId, sid)) return;
  if (!isActiveServerReachable()) return;

  pendingPlaylistIds.add(playlistId);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const ids = [...pendingPlaylistIds];
    pendingPlaylistIds.clear();
    const activeId = useAuthStore.getState().activeServerId;
    for (const id of ids) {
      void syncPinnedPlaylistIfNeeded(id, serverId ?? activeId ?? undefined);
    }
  }, DEBOUNCE_MS);
}

/** Re-sync every manually cached playlist (e.g. after reconnect / smart playlist server refresh). */
export async function syncAllPinnedPlaylists(): Promise<void> {
  if (!isActiveServerReachable()) return;

  const seen = new Set<string>();
  const jobs: { playlistId: string; serverId: string }[] = [];

  for (const meta of Object.values(useOfflineStore.getState().albums)) {
    if (meta.type !== 'playlist') continue;
    if (isSmartPlaylistName(meta.name)) continue;
    const serverId = resolveServerIdForIndexKey(meta.serverId) || meta.serverId;
    const key = `${serverId}:${meta.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ playlistId: meta.id, serverId });
  }

  for (const group of useLocalPlaybackStore.getState().listPinnedGroups()) {
    if (group.pinSource.kind !== 'playlist') continue;
    if (isSmartPlaylistName(group.pinSource.displayName ?? '')) continue;
    const serverId = resolveServerIdForIndexKey(group.serverIndexKey) || group.serverIndexKey;
    const key = `${serverId}:${group.pinSource.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ playlistId: group.pinSource.sourceId, serverId });
  }

  for (const job of jobs) {
    await syncPinnedPlaylistIfNeeded(job.playlistId, job.serverId);
  }
}

export function scheduleSyncAllPinnedPlaylists(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncAllPinnedPlaylists();
  }, DEBOUNCE_MS);
}

export function initPinnedPlaylistOfflineSync(): () => void {
  scheduleSyncAllPinnedPlaylists();
  const stopReachable = onActiveServerBecameReachable(() => scheduleSyncAllPinnedPlaylists());
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    stopReachable();
  };
}
