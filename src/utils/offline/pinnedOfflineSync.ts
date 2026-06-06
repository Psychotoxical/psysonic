import { getAlbumForServer, filterSongsToServerLibrary } from '../../api/subsonicLibrary';
import { getPlaylist } from '../../api/subsonicPlaylists';
import { getArtistForServer } from '../../api/subsonicArtists';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../store/authStore';
import type { PinSource } from '../../store/localPlaybackStore';
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

export type OfflinePinKind = PinSource['kind'];

const DEBOUNCE_MS = 600;
const RETRY_WHILE_DOWNLOADING_MS = 2500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSourceJobs: { kind: OfflinePinKind; sourceId: string; serverId?: string }[] = [];
const pendingArtistJobs: { artistId: string; serverId: string; albumIds?: string[] }[] = [];
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function serverIndexKeyForOffline(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

function belongsToProfile(metaServerKey: string, profileServerId: string): boolean {
  const indexKey = serverIndexKeyForOffline(profileServerId);
  return metaServerKey === profileServerId
    || metaServerKey === indexKey
    || resolveServerIdForIndexKey(metaServerKey) === profileServerId;
}

function offlineMeta(sourceId: string, serverId: string) {
  const indexKey = serverIndexKeyForOffline(serverId);
  const albums = useOfflineStore.getState().albums;
  return albums[`${indexKey}:${sourceId}`] ?? albums[`${serverId}:${sourceId}`];
}

function resolvePlaylistName(playlistId: string, serverId: string): string | undefined {
  return offlineMeta(playlistId, serverId)?.name
    ?? usePlaylistStore.getState().playlists.find(p => p.id === playlistId)?.name;
}

/** Smart playlists refresh from server rules — not eligible for manual offline cache/sync. */
export function isManualOfflinePlaylist(playlistId: string, serverId: string, name?: string): boolean {
  const resolved = name ?? resolvePlaylistName(playlistId, serverId);
  return !resolved || !isSmartPlaylistName(resolved);
}

/** True when a source was manually cached offline with the given pin kind. */
export function isSourcePinnedOffline(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
): boolean {
  const meta = offlineMeta(sourceId, serverId);
  if (meta?.type === kind) return true;

  const indexKey = serverIndexKeyForOffline(serverId);
  const group = useLocalPlaybackStore.getState()
    .listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === kind && g.pinSource.sourceId === sourceId);
  return (group?.trackIds.length ?? 0) > 0;
}

/** @deprecated Use {@link isSourcePinnedOffline} with kind `playlist`. */
export function isPlaylistPinnedOffline(playlistId: string, serverId: string): boolean {
  return isSourcePinnedOffline(playlistId, serverId, 'playlist');
}

function trackStillNeededByOtherPin(
  trackId: string,
  serverIndexKey: string,
  exceptKind: OfflinePinKind,
  exceptSourceId: string,
): boolean {
  for (const group of useLocalPlaybackStore.getState().listPinnedGroups(serverIndexKey)) {
    if (group.pinSource.kind === exceptKind && group.pinSource.sourceId === exceptSourceId) continue;
    if (group.trackIds.includes(trackId)) return true;
  }
  return false;
}

async function pruneRemovedPinTracks(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
  keepIds: Set<string>,
): Promise<void> {
  const indexKey = serverIndexKeyForOffline(serverId);
  const lp = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const group = lp.listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === kind && g.pinSource.sourceId === sourceId);
  const previousIds = group?.trackIds ?? offlineMeta(sourceId, serverId)?.trackIds ?? [];

  for (const trackId of previousIds) {
    if (keepIds.has(trackId)) continue;
    if (trackStillNeededByOtherPin(trackId, indexKey, kind, sourceId)) continue;

    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (!entry?.localPath || entry.tier !== 'library') continue;
    if (entry.pinSource?.kind !== kind || entry.pinSource.sourceId !== sourceId) continue;

    await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
    lp.removeEntry(trackId, entry.serverIndexKey, `${kind}-sync-prune`);
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

function updateOfflineMeta(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
  patch: {
    name: string;
    albumArtist: string;
    coverArt?: string;
    year?: number;
    trackIds: string[];
  },
): void {
  const indexKey = serverIndexKeyForOffline(serverId);
  useOfflineStore.setState(state => {
    const key = `${indexKey}:${sourceId}`;
    const legacyKey = `${serverId}:${sourceId}`;
    const existing = state.albums[key] ?? state.albums[legacyKey];
    const nextAlbums = { ...state.albums };
    delete nextAlbums[legacyKey];
    nextAlbums[key] = {
      ...(existing ?? {
        id: sourceId,
        serverId: indexKey,
        artist: patch.albumArtist,
      }),
      id: sourceId,
      serverId: indexKey,
      name: patch.name,
      artist: patch.albumArtist,
      coverArt: patch.coverArt ?? existing?.coverArt,
      year: patch.year ?? existing?.year,
      trackIds: patch.trackIds,
      type: kind,
    };
    return { albums: nextAlbums };
  });
}

function scheduleRetryWhileDownloading(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
): void {
  const key = `${serverId}:${kind}:${sourceId}`;
  const prev = retryTimers.get(key);
  if (prev) clearTimeout(prev);
  retryTimers.set(key, setTimeout(() => {
    retryTimers.delete(key);
    void syncPinnedSourceIfNeeded(sourceId, serverId, kind);
  }, RETRY_WHILE_DOWNLOADING_MS));
}

interface SyncPinOptions {
  prefetchedSongs?: SubsonicSong[];
  name?: string;
  albumArtist?: string;
  coverArt?: string;
  year?: number;
  artistProgressGroupId?: string;
  /** Download even when the source is not pinned yet (new album in a fully cached discography). */
  allowUnpinned?: boolean;
}

/**
 * Refresh a manually cached pin: download new tracks, drop removed ones,
 * update persisted offline metadata.
 */
export async function syncPinnedSourceIfNeeded(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
  options: SyncPinOptions = {},
): Promise<void> {
  if (!isActiveServerReachable()) return;
  const alreadyPinned = isSourcePinnedOffline(sourceId, serverId, kind);
  if (!alreadyPinned && !options.allowUnpinned) return;
  if (kind === 'playlist' && !isManualOfflinePlaylist(sourceId, serverId, options.name)) return;

  let songs = options.prefetchedSongs;
  let displayName = options.name ?? offlineMeta(sourceId, serverId)?.name ?? sourceId;
  let albumArtist = options.albumArtist ?? offlineMeta(sourceId, serverId)?.artist ?? '';
  let coverArt = options.coverArt ?? offlineMeta(sourceId, serverId)?.coverArt;
  let year = options.year ?? offlineMeta(sourceId, serverId)?.year;

  if (!songs) {
    try {
      if (kind === 'playlist') {
        const data = await getPlaylist(sourceId);
        displayName = data.playlist.name;
        coverArt = data.playlist.coverArt ?? coverArt;
        songs = await filterSongsToServerLibrary(data.songs, serverId);
      } else {
        const data = await getAlbumForServer(serverId, sourceId);
        displayName = data.album.name;
        albumArtist = data.album.artist ?? albumArtist;
        coverArt = data.album.coverArt ?? coverArt;
        year = data.album.year ?? year;
        songs = await filterSongsToServerLibrary(data.songs, serverId);
      }
    } catch {
      return;
    }
  } else {
    songs = await filterSongsToServerLibrary(songs, serverId);
  }

  const unique = dedupeSongs(songs);
  const keepIds = new Set(unique.map(s => s.id));

  await pruneRemovedPinTracks(sourceId, serverId, kind, keepIds);
  updateOfflineMeta(sourceId, serverId, kind, {
    name: displayName,
    albumArtist,
    coverArt,
    year,
    trackIds: unique.map(s => s.id),
  });

  const offline = useOfflineStore.getState();
  if (offline.isAlbumDownloading(sourceId)) {
    scheduleRetryWhileDownloading(sourceId, serverId, kind);
    return;
  }

  const enqueued = enqueueOfflinePin({
    albumId: sourceId,
    albumName: displayName,
    albumArtist,
    coverArt,
    year,
    songs: unique,
    serverId,
    type: kind,
    artistProgressGroupId: options.artistProgressGroupId,
  });
  if (!enqueued && offline.isAlbumDownloading(sourceId)) {
    scheduleRetryWhileDownloading(sourceId, serverId, kind);
  }
}

/** @deprecated Use {@link syncPinnedSourceIfNeeded} with kind `playlist`. */
export async function syncPinnedPlaylistIfNeeded(
  playlistId: string,
  serverId?: string,
  prefetchedSongs?: SubsonicSong[],
): Promise<void> {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid) return;
  await syncPinnedSourceIfNeeded(playlistId, sid, 'playlist', { prefetchedSongs });
}

export async function syncPinnedAlbumIfNeeded(
  albumId: string,
  serverId?: string,
  prefetchedSongs?: SubsonicSong[],
): Promise<void> {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid) return;
  await syncPinnedSourceIfNeeded(albumId, sid, 'album', { prefetchedSongs });
}

/** Any album in the artist discography was cached with type `artist`. */
export function isArtistDiscographyPinnedOffline(
  serverId: string,
  albumIds: string[],
): boolean {
  return albumIds.some(id => isSourcePinnedOffline(id, serverId, 'artist'));
}

function listPinnedArtistAlbumIds(serverId: string): string[] {
  const ids = new Set<string>();
  for (const meta of Object.values(useOfflineStore.getState().albums)) {
    if (meta.type !== 'artist') continue;
    if (!belongsToProfile(meta.serverId, serverId)) continue;
    ids.add(meta.id);
  }
  for (const group of useLocalPlaybackStore.getState().listPinnedGroups()) {
    if (group.pinSource.kind !== 'artist') continue;
    if (!belongsToProfile(group.serverIndexKey, serverId)) continue;
    ids.add(group.pinSource.sourceId);
  }
  return [...ids];
}

/**
 * Reconcile a cached artist discography: refresh pinned albums, drop albums
 * removed from the catalog, and fetch new albums when the scope was fully cached.
 */
export async function syncPinnedArtistIfNeeded(
  artistId: string,
  serverId?: string,
  knownAlbumIds?: string[],
): Promise<void> {
  if (!isActiveServerReachable()) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !artistId) return;

  const pinnedBefore = listPinnedArtistAlbumIds(sid);
  const scopeIds = knownAlbumIds ?? pinnedBefore;
  if (!isArtistDiscographyPinnedOffline(sid, scopeIds) && pinnedBefore.length === 0) return;

  let liveAlbumIds: string[] = [];
  try {
    const { albums } = await getArtistForServer(sid, artistId);
    liveAlbumIds = albums.map(a => a.id);
  } catch {
    return;
  }

  const scopeFullyPinned = scopeIds.length > 0
    && scopeIds.every(id => isSourcePinnedOffline(id, sid, 'artist'));
  const liveSet = new Set(liveAlbumIds);

  for (const oldAlbumId of pinnedBefore) {
    if (liveSet.has(oldAlbumId)) continue;
    await pruneRemovedPinTracks(oldAlbumId, sid, 'artist', new Set());
    const indexKey = serverIndexKeyForOffline(sid);
    useOfflineStore.setState(state => {
      const albums = { ...state.albums };
      delete albums[`${indexKey}:${oldAlbumId}`];
      delete albums[`${sid}:${oldAlbumId}`];
      return { albums };
    });
  }

  for (const albumId of liveAlbumIds) {
    const shouldSync = isSourcePinnedOffline(albumId, sid, 'artist')
      || (scopeFullyPinned && pinnedBefore.length > 0);
    if (!shouldSync) continue;
    await syncPinnedSourceIfNeeded(albumId, sid, 'artist', {
      artistProgressGroupId: artistId,
      allowUnpinned: !isSourcePinnedOffline(albumId, sid, 'artist'),
    });
  }
}

function flushPendingSyncJobs(): void {
  debounceTimer = null;
  const sources = [...pendingSourceJobs];
  const artists = [...pendingArtistJobs];
  pendingSourceJobs.length = 0;
  pendingArtistJobs.length = 0;
  const activeId = useAuthStore.getState().activeServerId;

  for (const job of sources) {
    void syncPinnedSourceIfNeeded(
      job.sourceId,
      job.serverId ?? activeId ?? '',
      job.kind,
    );
  }
  for (const job of artists) {
    void syncPinnedArtistIfNeeded(job.artistId, job.serverId, job.albumIds);
  }
}

function scheduleDebouncedSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPendingSyncJobs, DEBOUNCE_MS);
}

export function schedulePinnedPlaylistSync(playlistId: string, serverId?: string): void {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!playlistId || !sid) return;
  if (!isSourcePinnedOffline(playlistId, sid, 'playlist')) return;
  if (!isManualOfflinePlaylist(playlistId, sid)) return;
  if (!isActiveServerReachable()) return;
  pendingSourceJobs.push({ kind: 'playlist', sourceId: playlistId, serverId: sid });
  scheduleDebouncedSync();
}

export function schedulePinnedAlbumSync(albumId: string, serverId?: string): void {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!albumId || !sid) return;
  if (!isSourcePinnedOffline(albumId, sid, 'album')) return;
  if (!isActiveServerReachable()) return;
  pendingSourceJobs.push({ kind: 'album', sourceId: albumId, serverId: sid });
  scheduleDebouncedSync();
}

export function schedulePinnedArtistSync(
  artistId: string,
  serverId?: string,
  albumIds?: string[],
): void {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !artistId) return;
  if (!isArtistDiscographyPinnedOffline(sid, albumIds ?? listPinnedArtistAlbumIds(sid))) return;
  if (!isActiveServerReachable()) return;
  pendingArtistJobs.push({ artistId, serverId: sid, albumIds });
  scheduleDebouncedSync();
}

export async function syncAllPinnedOffline(): Promise<void> {
  if (!isActiveServerReachable()) return;

  const seen = new Set<string>();
  const jobs: { sourceId: string; serverId: string; kind: OfflinePinKind }[] = [];

  for (const meta of Object.values(useOfflineStore.getState().albums)) {
    const kind = meta.type ?? 'album';
    if (kind === 'playlist' && isSmartPlaylistName(meta.name)) continue;
    const serverId = resolveServerIdForIndexKey(meta.serverId) || meta.serverId;
    const dedupe = `${kind}:${serverId}:${meta.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    jobs.push({ sourceId: meta.id, serverId, kind });
  }

  for (const group of useLocalPlaybackStore.getState().listPinnedGroups()) {
    const kind = group.pinSource.kind;
    if (kind === 'playlist' && isSmartPlaylistName(group.pinSource.displayName ?? '')) continue;
    const serverId = resolveServerIdForIndexKey(group.serverIndexKey) || group.serverIndexKey;
    const dedupe = `${kind}:${serverId}:${group.pinSource.sourceId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    jobs.push({ sourceId: group.pinSource.sourceId, serverId, kind });
  }

  for (const job of jobs) {
    if (job.kind === 'playlist' && !isManualOfflinePlaylist(job.sourceId, job.serverId)) continue;
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, job.kind);
  }
}

/** @deprecated Use {@link syncAllPinnedOffline}. */
export async function syncAllPinnedPlaylists(): Promise<void> {
  await syncAllPinnedOffline();
}

export function scheduleSyncAllPinnedOffline(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncAllPinnedOffline();
  }, DEBOUNCE_MS);
}

/** @deprecated Use {@link scheduleSyncAllPinnedOffline}. */
export function scheduleSyncAllPinnedPlaylists(): void {
  scheduleSyncAllPinnedOffline();
}

export function initPinnedOfflineSync(): () => void {
  scheduleSyncAllPinnedOffline();
  const stopReachable = onActiveServerBecameReachable(() => scheduleSyncAllPinnedOffline());
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    stopReachable();
  };
}

/** @deprecated Use {@link initPinnedOfflineSync}. */
export function initPinnedPlaylistOfflineSync(): () => void {
  return initPinnedOfflineSync();
}
