import { libraryGetTracksByAlbum, subscribeLibrarySyncIdle } from '../../api/library';
import { getAlbumForServer, filterSongsToServerLibrary } from '../../api/subsonicLibrary';
import { getPlaylistForServer } from '../../api/subsonicPlaylists';
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
/** Cached regular playlists reconcile on this interval (and on in-app edits). */
const PLAYLIST_SYNC_INTERVAL_MS = 60 * 60 * 1000;

let playlistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let albumArtistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPlaylistJobs: { sourceId: string; serverId: string }[] = [];
const pendingAlbumJobs: { sourceId: string; serverId: string }[] = [];
const pendingArtistJobs: { artistId: string; serverId: string; albumIds?: string[] }[] = [];
/** Empty set entry means all servers; otherwise profile ids from library idle. */
const pendingAlbumArtistServers = new Set<string | null>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let playlistSyncInterval: ReturnType<typeof setInterval> | null = null;
let stopLibraryIdle: (() => void) | null = null;

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
        const data = await getPlaylistForServer(serverId, sourceId);
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
 * When every album in the known scope is already pinned, newly released albums
 * download automatically (intended “keep discography complete” UX).
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

  let liveAlbumIds: string[];
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

function pushUniquePlaylistJob(sourceId: string, serverId: string): void {
  if (pendingPlaylistJobs.some(j => j.sourceId === sourceId && j.serverId === serverId)) return;
  pendingPlaylistJobs.push({ sourceId, serverId });
}

function pushUniqueAlbumJob(sourceId: string, serverId: string): void {
  if (pendingAlbumJobs.some(j => j.sourceId === sourceId && j.serverId === serverId)) return;
  pendingAlbumJobs.push({ sourceId, serverId });
}

function pushUniqueArtistJob(artistId: string, serverId: string, albumIds?: string[]): void {
  if (pendingArtistJobs.some(j => j.artistId === artistId && j.serverId === serverId)) return;
  pendingArtistJobs.push({ artistId, serverId, albumIds });
}

function flushPendingPlaylistJobs(): void {
  playlistDebounceTimer = null;
  const jobs = [...pendingPlaylistJobs];
  pendingPlaylistJobs.length = 0;

  for (const job of jobs) {
    void syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'playlist');
  }
}

function flushPendingAlbumArtistJobs(): void {
  albumArtistDebounceTimer = null;
  const albums = [...pendingAlbumJobs];
  const artists = [...pendingArtistJobs];
  const servers = [...pendingAlbumArtistServers];
  pendingAlbumJobs.length = 0;
  pendingArtistJobs.length = 0;
  pendingAlbumArtistServers.clear();

  for (const job of albums) {
    void syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'album');
  }
  for (const job of artists) {
    void syncPinnedArtistIfNeeded(job.artistId, job.serverId, job.albumIds);
  }
  if (servers.length > 0) {
    for (const serverId of servers) {
      void syncAllPinnedAlbumsAndArtists(serverId ?? undefined);
    }
  }
}

function scheduleDebouncedPlaylistSync(): void {
  if (playlistDebounceTimer) clearTimeout(playlistDebounceTimer);
  playlistDebounceTimer = setTimeout(flushPendingPlaylistJobs, DEBOUNCE_MS);
}

function scheduleDebouncedAlbumArtistSync(): void {
  if (albumArtistDebounceTimer) clearTimeout(albumArtistDebounceTimer);
  albumArtistDebounceTimer = setTimeout(flushPendingAlbumArtistJobs, DEBOUNCE_MS);
}

function metaMatchesServer(metaServerKey: string, serverId?: string): boolean {
  if (!serverId) return true;
  return belongsToProfile(metaServerKey, serverId);
}

async function groupPinnedArtistAlbumsByArtistId(
  serverId: string,
  albumIds: Iterable<string>,
): Promise<Map<string, string[]>> {
  const byArtist = new Map<string, string[]>();
  for (const albumId of albumIds) {
    try {
      const tracks = await libraryGetTracksByAlbum(serverId, albumId);
      const artistId = tracks[0]?.artistId;
      if (!artistId) continue;
      const list = byArtist.get(artistId) ?? [];
      list.push(albumId);
      byArtist.set(artistId, list);
    } catch {
      // index row missing — fall back to per-album reconcile below
    }
  }
  return byArtist;
}

export function schedulePinnedPlaylistSync(playlistId: string, serverId?: string): void {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!playlistId || !sid) return;
  if (!isSourcePinnedOffline(playlistId, sid, 'playlist')) return;
  if (!isManualOfflinePlaylist(playlistId, sid)) return;
  if (!isActiveServerReachable()) return;
  pushUniquePlaylistJob(playlistId, sid);
  scheduleDebouncedPlaylistSync();
}

export function schedulePinnedAlbumSync(albumId: string, serverId?: string): void {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!albumId || !sid) return;
  if (!isSourcePinnedOffline(albumId, sid, 'album')) return;
  if (!isActiveServerReachable()) return;
  pushUniqueAlbumJob(albumId, sid);
  scheduleDebouncedAlbumArtistSync();
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
  pushUniqueArtistJob(artistId, sid, albumIds);
  scheduleDebouncedAlbumArtistSync();
}

/** Reconcile every cached album pin and artist discography (optionally one server). */
export async function syncAllPinnedAlbumsAndArtists(serverId?: string): Promise<void> {
  if (!isActiveServerReachable()) return;

  const seenAlbums = new Set<string>();
  const artistAlbumIdsByServer = new Map<string, Set<string>>();

  const albumJobs: { sourceId: string; serverId: string }[] = [];

  const consider = (kind: OfflinePinKind, sourceId: string, metaServerKey: string) => {
    if (kind === 'playlist') return;
    const sid = resolveServerIdForIndexKey(metaServerKey) || metaServerKey;
    if (!metaMatchesServer(metaServerKey, serverId) && !metaMatchesServer(sid, serverId)) return;

    if (kind === 'album') {
      const dedupe = `${sid}:${sourceId}`;
      if (seenAlbums.has(dedupe)) return;
      seenAlbums.add(dedupe);
      albumJobs.push({ sourceId, serverId: sid });
      return;
    }
    if (kind === 'artist') {
      const set = artistAlbumIdsByServer.get(sid) ?? new Set<string>();
      set.add(sourceId);
      artistAlbumIdsByServer.set(sid, set);
    }
  };

  for (const meta of Object.values(useOfflineStore.getState().albums)) {
    consider(meta.type ?? 'album', meta.id, meta.serverId);
  }
  for (const group of useLocalPlaybackStore.getState().listPinnedGroups()) {
    consider(group.pinSource.kind, group.pinSource.sourceId, group.serverIndexKey);
  }

  for (const job of albumJobs) {
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'album');
  }

  for (const [sid, albumIds] of artistAlbumIdsByServer) {
    const byArtist = await groupPinnedArtistAlbumsByArtistId(sid, albumIds);
    const assignedAlbums = new Set<string>();
    for (const [artistId, ids] of byArtist) {
      ids.forEach(id => assignedAlbums.add(id));
      await syncPinnedArtistIfNeeded(artistId, sid, ids);
    }
    for (const albumId of albumIds) {
      if (assignedAlbums.has(albumId)) continue;
      await syncPinnedSourceIfNeeded(albumId, sid, 'artist');
    }
  }
}

/** Reconcile every manually cached regular playlist (optionally one server). */
export async function syncAllPinnedPlaylists(serverId?: string): Promise<void> {
  if (!isActiveServerReachable()) return;

  const seen = new Set<string>();
  const jobs: { sourceId: string; serverId: string }[] = [];

  for (const meta of Object.values(useOfflineStore.getState().albums)) {
    if (meta.type !== 'playlist') continue;
    if (isSmartPlaylistName(meta.name)) continue;
    const sid = resolveServerIdForIndexKey(meta.serverId) || meta.serverId;
    if (!metaMatchesServer(meta.serverId, serverId) && !metaMatchesServer(sid, serverId)) continue;
    const dedupe = `${sid}:${meta.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    jobs.push({ sourceId: meta.id, serverId: sid });
  }

  for (const group of useLocalPlaybackStore.getState().listPinnedGroups()) {
    if (group.pinSource.kind !== 'playlist') continue;
    if (isSmartPlaylistName(group.pinSource.displayName ?? '')) continue;
    const sid = resolveServerIdForIndexKey(group.serverIndexKey) || group.serverIndexKey;
    if (!metaMatchesServer(group.serverIndexKey, serverId) && !metaMatchesServer(sid, serverId)) continue;
    const dedupe = `${sid}:${group.pinSource.sourceId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    jobs.push({ sourceId: group.pinSource.sourceId, serverId: sid });
  }

  for (const job of jobs) {
    if (!isManualOfflinePlaylist(job.sourceId, job.serverId)) continue;
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'playlist');
  }
}

/** @deprecated Use {@link syncAllPinnedAlbumsAndArtists} + {@link syncAllPinnedPlaylists}. */
export async function syncAllPinnedOffline(): Promise<void> {
  await syncAllPinnedAlbumsAndArtists();
  await syncAllPinnedPlaylists();
}

export function scheduleSyncPinnedAlbumsAndArtists(serverId?: string): void {
  if (!isActiveServerReachable()) return;
  pendingAlbumArtistServers.add(serverId ?? null);
  scheduleDebouncedAlbumArtistSync();
}

/** @deprecated Use {@link scheduleSyncPinnedAlbumsAndArtists}. */
export function scheduleSyncAllPinnedOffline(): void {
  scheduleSyncPinnedAlbumsAndArtists();
  void syncAllPinnedPlaylists();
}

/** @deprecated Use hourly {@link syncAllPinnedPlaylists}. */
export function scheduleSyncAllPinnedPlaylists(): void {
  if (!isActiveServerReachable()) return;
  void syncAllPinnedPlaylists();
}

function onLibraryBecameIdle(serverIndexKey: string, kind: string, ok: boolean): void {
  if (!ok) return;
  if (kind !== 'initial_sync' && kind !== 'delta_sync') return;
  if (!isActiveServerReachable()) return;
  const serverId = resolveServerIdForIndexKey(serverIndexKey);
  scheduleSyncPinnedAlbumsAndArtists(serverId);
}

export function initPinnedOfflineSync(): () => void {
  void subscribeLibrarySyncIdle(payload => {
    onLibraryBecameIdle(payload.serverId, payload.kind, payload.ok);
  }).then(unlisten => {
    stopLibraryIdle = unlisten;
  });

  playlistSyncInterval = setInterval(() => {
    if (isActiveServerReachable()) void syncAllPinnedPlaylists();
  }, PLAYLIST_SYNC_INTERVAL_MS);

  const stopReachable = onActiveServerBecameReachable(() => {
    scheduleSyncPinnedAlbumsAndArtists();
  });

  return () => {
    if (playlistDebounceTimer) clearTimeout(playlistDebounceTimer);
    if (albumArtistDebounceTimer) clearTimeout(albumArtistDebounceTimer);
    if (playlistSyncInterval) clearInterval(playlistSyncInterval);
    stopLibraryIdle?.();
    stopLibraryIdle = null;
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    stopReachable();
  };
}

/** @deprecated Use {@link initPinnedOfflineSync}. */
export function initPinnedPlaylistOfflineSync(): () => void {
  return initPinnedOfflineSync();
}
