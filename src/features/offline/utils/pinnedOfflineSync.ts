import { libraryGetTracksByAlbum, subscribeLibrarySyncIdle } from '@/lib/api/library';
import { getAlbumForServer, filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import {
  localPlaybackEntryHasPinSource,
  useLocalPlaybackStore,
  type PinSource,
} from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { isSmartPlaylistName } from '@/lib/format/playlistDetailHelpers';
import { getMediaDir } from '@/lib/media/mediaDir';
import {
  isActiveServerReachable,
  onActiveServerBecameReachable,
} from '@/lib/network/activeServerReachability';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { findLocalPlaybackEntry } from '@/store/localPlaybackResolve';
import {
  enqueueOfflinePin,
  getOfflinePinCancellationEpoch,
} from '@/features/offline/utils/offlinePinQueue';
import {
  beginOfflineSourceOperation,
  getOfflineSourceGeneration,
  runOfflineTrackDeletionBatch,
} from '@/features/offline/utils/offlineOperationCoordinator';

export type OfflinePinKind = PinSource['kind'];

const DEBOUNCE_MS = 600;
const RETRY_WHILE_DOWNLOADING_MS = 2500;
/** Cached regular playlists reconcile on this interval (and on in-app edits). */
const PLAYLIST_SYNC_INTERVAL_MS = 60 * 60 * 1000;

let playlistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let albumArtistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPlaylistJobs: { sourceId: string; serverId: string; epoch: number }[] = [];
const pendingAlbumJobs: { sourceId: string; serverId: string; epoch: number }[] = [];
const pendingArtistJobs: {
  artistId: string;
  serverId: string;
  albumIds?: string[];
  epoch: number;
}[] = [];
/** Empty set entry means all servers; otherwise profile ids from library idle. */
const pendingAlbumArtistServers = new Map<string | null, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let offlineSyncLifecycleGeneration = 0;

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
  // Only pinned playlists reach the nameless internal callers (all gated by
  // isSourcePinnedOffline), so offline meta always carries the name here; external
  // callers pass `name` explicitly. Avoid importing the playlist feature barrel —
  // that edge closes offline↔playlist import cycles (see 2026-07 detangle task).
  return offlineMeta(playlistId, serverId)?.name;
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

async function pruneRemovedPinTracks(
  sourceId: string,
  serverId: string,
  kind: OfflinePinKind,
  keepIds: Set<string>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const indexKey = serverIndexKeyForOffline(serverId);
  const lp = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const pinSource: PinSource = { kind, sourceId };
  const group = lp.listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === kind && g.pinSource.sourceId === sourceId);
  const previousIds = group?.trackIds ?? offlineMeta(sourceId, serverId)?.trackIds ?? [];

  for (const trackId of previousIds) {
    if (!shouldContinue()) return;
    if (keepIds.has(trackId)) continue;

    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (!entry?.localPath || entry.tier !== 'library') continue;
    if (!localPlaybackEntryHasPinSource(entry, pinSource)) continue;

    await runOfflineTrackDeletionBatch(
      [{ serverIndexKey: indexKey, trackId }],
      async () => {
        if (!shouldContinue()) return;
        const current = findLocalPlaybackEntry(trackId, serverId);
        if (
          current?.serverIndexKey !== entry.serverIndexKey
          || current.localPath !== entry.localPath
          || !localPlaybackEntryHasPinSource(current, pinSource)
        ) return;
        await lp.removePinSource(
          trackId,
          entry.serverIndexKey,
          pinSource,
          mediaDir,
          `${kind}-sync-prune`,
        );
      },
    );
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
  cancellationEpoch: number,
): void {
  const key = `${serverId}:${kind}:${sourceId}`;
  const prev = retryTimers.get(key);
  if (prev) clearTimeout(prev);
  retryTimers.set(key, setTimeout(() => {
    retryTimers.delete(key);
    void syncPinnedSourceIfNeeded(sourceId, serverId, kind, { cancellationEpoch });
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
  cancellationEpoch?: number;
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
  const lifecycleGeneration = offlineSyncLifecycleGeneration;
  const cancellationEpoch = options.cancellationEpoch ?? getOfflinePinCancellationEpoch();
  const indexKey = serverIndexKeyForOffline(serverId);
  if (getOfflinePinCancellationEpoch() !== cancellationEpoch) return;
  if (!isActiveServerReachable()) return;
  const alreadyPinned = isSourcePinnedOffline(sourceId, serverId, kind);
  if (!alreadyPinned && !options.allowUnpinned) return;
  if (kind === 'playlist' && !isManualOfflinePlaylist(sourceId, serverId, options.name)) return;
  const sourceGeneration = beginOfflineSourceOperation(indexKey, kind, sourceId);
  const isCurrent = () => offlineSyncLifecycleGeneration === lifecycleGeneration
    && getOfflinePinCancellationEpoch() === cancellationEpoch
    && getOfflineSourceGeneration(indexKey, kind, sourceId) === sourceGeneration;

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
  if (!isCurrent()) return;

  const unique = dedupeSongs(songs);
  const keepIds = new Set(unique.map(s => s.id));

  await pruneRemovedPinTracks(sourceId, serverId, kind, keepIds, isCurrent);
  if (!isCurrent()) return;
  updateOfflineMeta(sourceId, serverId, kind, {
    name: displayName,
    albumArtist,
    coverArt,
    year,
    trackIds: unique.map(s => s.id),
  });

  const offline = useOfflineStore.getState();
  if (offline.isAlbumDownloading(sourceId, serverId)) {
    scheduleRetryWhileDownloading(sourceId, serverId, kind, cancellationEpoch);
    return;
  }

  if (!isCurrent()) return;

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
  if (!enqueued && offline.isAlbumDownloading(sourceId, serverId)) {
    scheduleRetryWhileDownloading(sourceId, serverId, kind, cancellationEpoch);
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
  cancellationEpoch = getOfflinePinCancellationEpoch(),
): Promise<void> {
  const lifecycleGeneration = offlineSyncLifecycleGeneration;
  if (getOfflinePinCancellationEpoch() !== cancellationEpoch) return;
  if (!isActiveServerReachable()) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !artistId) return;

  const pinnedBefore = listPinnedArtistAlbumIds(sid);
  const scopeIds = knownAlbumIds ?? pinnedBefore;
  if (!isArtistDiscographyPinnedOffline(sid, scopeIds) && pinnedBefore.length === 0) return;
  const indexKey = serverIndexKeyForOffline(sid);
  const artistGeneration = beginOfflineSourceOperation(indexKey, 'artist-reconcile', artistId);
  const isArtistCurrent = () => offlineSyncLifecycleGeneration === lifecycleGeneration
    && getOfflinePinCancellationEpoch() === cancellationEpoch
    && getOfflineSourceGeneration(indexKey, 'artist-reconcile', artistId) === artistGeneration;

  let liveAlbumIds: string[];
  try {
    const { albums } = await getArtistForServer(sid, artistId);
    liveAlbumIds = albums.map(a => a.id);
  } catch {
    return;
  }
  if (!isArtistCurrent()) return;

  const scopeFullyPinned = scopeIds.length > 0
    && scopeIds.every(id => isSourcePinnedOffline(id, sid, 'artist'));
  const liveSet = new Set(liveAlbumIds);

  for (const oldAlbumId of pinnedBefore) {
    if (!isArtistCurrent()) return;
    if (liveSet.has(oldAlbumId)) continue;
    const sourceGeneration = getOfflineSourceGeneration(indexKey, 'artist', oldAlbumId);
    const isCurrent = () => isArtistCurrent()
      && getOfflineSourceGeneration(indexKey, 'artist', oldAlbumId) === sourceGeneration;
    await pruneRemovedPinTracks(oldAlbumId, sid, 'artist', new Set(), isCurrent);
    if (!isArtistCurrent()) return;
    if (!isCurrent()) continue;
    useOfflineStore.setState(state => {
      const albums = { ...state.albums };
      delete albums[`${indexKey}:${oldAlbumId}`];
      delete albums[`${sid}:${oldAlbumId}`];
      return { albums };
    });
  }

  for (const albumId of liveAlbumIds) {
    if (!isArtistCurrent()) return;
    const shouldSync = isSourcePinnedOffline(albumId, sid, 'artist')
      || (scopeFullyPinned && pinnedBefore.length > 0);
    if (!shouldSync) continue;
    await syncPinnedSourceIfNeeded(albumId, sid, 'artist', {
      artistProgressGroupId: artistId,
      allowUnpinned: !isSourcePinnedOffline(albumId, sid, 'artist'),
      cancellationEpoch,
    });
  }
}

function pushUniquePlaylistJob(sourceId: string, serverId: string): void {
  const epoch = getOfflinePinCancellationEpoch();
  const existing = pendingPlaylistJobs.find(j => j.sourceId === sourceId && j.serverId === serverId);
  if (existing) {
    existing.epoch = epoch;
    return;
  }
  pendingPlaylistJobs.push({ sourceId, serverId, epoch });
}

function pushUniqueAlbumJob(sourceId: string, serverId: string): void {
  const epoch = getOfflinePinCancellationEpoch();
  const existing = pendingAlbumJobs.find(j => j.sourceId === sourceId && j.serverId === serverId);
  if (existing) {
    existing.epoch = epoch;
    return;
  }
  pendingAlbumJobs.push({ sourceId, serverId, epoch });
}

function pushUniqueArtistJob(artistId: string, serverId: string, albumIds?: string[]): void {
  const epoch = getOfflinePinCancellationEpoch();
  const existing = pendingArtistJobs.find(j => j.artistId === artistId && j.serverId === serverId);
  if (existing) {
    existing.albumIds = albumIds;
    existing.epoch = epoch;
    return;
  }
  pendingArtistJobs.push({ artistId, serverId, albumIds, epoch });
}

function flushPendingPlaylistJobs(): void {
  playlistDebounceTimer = null;
  const jobs = [...pendingPlaylistJobs];
  pendingPlaylistJobs.length = 0;

  for (const job of jobs) {
    if (job.epoch !== getOfflinePinCancellationEpoch()) continue;
    void syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'playlist', {
      cancellationEpoch: job.epoch,
    });
  }
}

function flushPendingAlbumArtistJobs(): void {
  albumArtistDebounceTimer = null;
  const albums = [...pendingAlbumJobs];
  const artists = [...pendingArtistJobs];
  const servers = [...pendingAlbumArtistServers.entries()];
  pendingAlbumJobs.length = 0;
  pendingArtistJobs.length = 0;
  pendingAlbumArtistServers.clear();

  for (const job of albums) {
    if (job.epoch !== getOfflinePinCancellationEpoch()) continue;
    void syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'album', {
      cancellationEpoch: job.epoch,
    });
  }
  for (const job of artists) {
    if (job.epoch !== getOfflinePinCancellationEpoch()) continue;
    void syncPinnedArtistIfNeeded(job.artistId, job.serverId, job.albumIds, job.epoch);
  }
  if (servers.length > 0) {
    for (const [serverId, epoch] of servers) {
      if (epoch !== getOfflinePinCancellationEpoch()) continue;
      void syncAllPinnedAlbumsAndArtists(serverId ?? undefined, epoch);
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
export async function syncAllPinnedAlbumsAndArtists(
  serverId?: string,
  cancellationEpoch = getOfflinePinCancellationEpoch(),
  lifecycleGeneration = offlineSyncLifecycleGeneration,
): Promise<void> {
  const isCurrent = () => offlineSyncLifecycleGeneration === lifecycleGeneration
    && getOfflinePinCancellationEpoch() === cancellationEpoch;
  if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'album', {
      cancellationEpoch,
    });
  }

  for (const [sid, albumIds] of artistAlbumIdsByServer) {
    if (!isCurrent()) return;
    const byArtist = await groupPinnedArtistAlbumsByArtistId(sid, albumIds);
    if (!isCurrent()) return;
    const assignedAlbums = new Set<string>();
    for (const [artistId, ids] of byArtist) {
      if (!isCurrent()) return;
      ids.forEach(id => assignedAlbums.add(id));
      await syncPinnedArtistIfNeeded(artistId, sid, ids, cancellationEpoch);
    }
    for (const albumId of albumIds) {
      if (!isCurrent()) return;
      if (assignedAlbums.has(albumId)) continue;
      await syncPinnedSourceIfNeeded(albumId, sid, 'artist', { cancellationEpoch });
    }
  }
}

/** Reconcile every manually cached regular playlist (optionally one server). */
export async function syncAllPinnedPlaylists(
  serverId?: string,
  cancellationEpoch = getOfflinePinCancellationEpoch(),
  lifecycleGeneration = offlineSyncLifecycleGeneration,
): Promise<void> {
  const isCurrent = () => offlineSyncLifecycleGeneration === lifecycleGeneration
    && getOfflinePinCancellationEpoch() === cancellationEpoch;
  if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    if (!isManualOfflinePlaylist(job.sourceId, job.serverId)) continue;
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'playlist', {
      cancellationEpoch,
    });
  }
}

/** @deprecated Use {@link syncAllPinnedAlbumsAndArtists} + {@link syncAllPinnedPlaylists}. */
export async function syncAllPinnedOffline(): Promise<void> {
  const cancellationEpoch = getOfflinePinCancellationEpoch();
  const lifecycleGeneration = offlineSyncLifecycleGeneration;
  await syncAllPinnedAlbumsAndArtists(undefined, cancellationEpoch, lifecycleGeneration);
  await syncAllPinnedPlaylists(undefined, cancellationEpoch, lifecycleGeneration);
}

export function scheduleSyncPinnedAlbumsAndArtists(serverId?: string): void {
  if (!isActiveServerReachable()) return;
  pendingAlbumArtistServers.set(serverId ?? null, getOfflinePinCancellationEpoch());
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
  const lifecycleGeneration = ++offlineSyncLifecycleGeneration;
  let disposed = false;
  let stopLibraryIdle: (() => void) | null = null;
  void subscribeLibrarySyncIdle(payload => {
    if (disposed) return;
    onLibraryBecameIdle(payload.serverId, payload.kind, payload.ok);
  }).then(unlisten => {
    if (disposed) unlisten();
    else stopLibraryIdle = unlisten;
  });

  const playlistSyncInterval = setInterval(() => {
    if (disposed) return;
    if (isActiveServerReachable()) {
      void syncAllPinnedPlaylists(
        undefined,
        getOfflinePinCancellationEpoch(),
        lifecycleGeneration,
      );
    }
  }, PLAYLIST_SYNC_INTERVAL_MS);

  const stopReachable = onActiveServerBecameReachable(() => {
    if (disposed) return;
    scheduleSyncPinnedAlbumsAndArtists();
  });

  return () => {
    disposed = true;
    if (offlineSyncLifecycleGeneration === lifecycleGeneration) {
      offlineSyncLifecycleGeneration += 1;
    }
    if (playlistDebounceTimer) clearTimeout(playlistDebounceTimer);
    if (albumArtistDebounceTimer) clearTimeout(albumArtistDebounceTimer);
    playlistDebounceTimer = null;
    albumArtistDebounceTimer = null;
    pendingPlaylistJobs.length = 0;
    pendingAlbumJobs.length = 0;
    pendingArtistJobs.length = 0;
    pendingAlbumArtistServers.clear();
    clearInterval(playlistSyncInterval);
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
