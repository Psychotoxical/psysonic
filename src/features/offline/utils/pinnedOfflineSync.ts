import { libraryGetTracksByAlbum, subscribeLibrarySyncIdle } from '@/lib/api/library';
import { getAlbumForServer, filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import type { PinSource } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { isSmartPlaylistName } from '@/lib/format/playlistDetailHelpers';
import { getMediaDir } from '@/lib/media/mediaDir';
import { deleteMediaFile, probeMediaFiles } from '@/lib/api/syncfs';
import {
  isActiveServerReachable,
  onActiveServerBecameReachable,
} from '@/lib/network/activeServerReachability';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { findLocalPlaybackEntry } from '@/store/localPlaybackResolve';
import {
  canonicalizeOfflinePinTask,
  enqueueOfflinePin,
} from '@/features/offline/utils/offlinePinQueue';
import {
  canonicalIdentityGeneration,
  canonicalIdentityGenerationChanged,
  canonicalizeConfirmedNavidromeId,
  canonicalizeNavidromeId,
} from '@/lib/server/navidromeCanonicalIds';

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
const sourceSyncGeneration = new Map<string, number>();
const sourceMutationTail = new Map<string, Promise<void>>();
let sourceSyncLifecycle = 0;
let syncPauseDepth = 0;
let playlistSyncInterval: ReturnType<typeof setInterval> | null = null;
let stopLibraryIdle: (() => void) | null = null;

function serverIndexKeyForOffline(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  return resolveIndexKey(serverId) || serverId;
}

function beginSourceSync(sourceId: string, serverId: string, kind: OfflinePinKind): {
  key: string;
  isCurrent: () => boolean;
  abandon: () => void;
} {
  const key = `${serverIndexKeyForOffline(serverId)}:${kind}:${canonicalizeNavidromeId(sourceId)}`;
  const previous = sourceSyncGeneration.get(key) ?? 0;
  const generation = previous + 1;
  const lifecycle = sourceSyncLifecycle;
  sourceSyncGeneration.set(key, generation);
  return {
    key,
    isCurrent: () => sourceSyncLifecycle === lifecycle && sourceSyncGeneration.get(key) === generation,
    abandon: () => {
      if (sourceSyncGeneration.get(key) !== generation) return;
      if (previous === 0) sourceSyncGeneration.delete(key);
      else sourceSyncGeneration.set(key, previous);
    },
  };
}

async function runSourceMutation(key: string, mutation: () => Promise<void>): Promise<void> {
  const previous = sourceMutationTail.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(mutation);
  sourceMutationTail.set(key, current);
  try {
    await current;
  } finally {
    if (sourceMutationTail.get(key) === current) sourceMutationTail.delete(key);
  }
}

function belongsToProfile(metaServerKey: string, profileServerId: string): boolean {
  const indexKey = serverIndexKeyForOffline(profileServerId);
  return metaServerKey === profileServerId
    || metaServerKey === indexKey
    || resolveServerIdForIndexKey(metaServerKey) === profileServerId;
}

function offlineMeta(sourceId: string, serverId: string) {
  const indexKey = serverIndexKeyForOffline(serverId);
  const activeSourceId = canonicalizeConfirmedNavidromeId(indexKey, sourceId);
  const albums = useOfflineStore.getState().albums;
  return albums[`${indexKey}:${activeSourceId}`]
    ?? albums[`${indexKey}:${sourceId}`]
    ?? albums[`${serverId}:${activeSourceId}`]
    ?? albums[`${serverId}:${sourceId}`];
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
  sourceId = canonicalizeConfirmedNavidromeId(indexKey, sourceId);
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
  expectedIdentityGeneration = canonicalIdentityGeneration(serverIndexKeyForOffline(serverId)),
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const indexKey = serverIndexKeyForOffline(serverId);
  sourceId = canonicalizeConfirmedNavidromeId(indexKey, sourceId);
  keepIds = new Set([...keepIds].map(id => canonicalizeConfirmedNavidromeId(indexKey, id)));
  const lp = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const group = lp.listPinnedGroups(indexKey)
    .find(g => g.pinSource.kind === kind && g.pinSource.sourceId === sourceId);
  const previousIds = group?.trackIds ?? offlineMeta(sourceId, serverId)?.trackIds ?? [];

  for (const previousTrackId of previousIds) {
    if (!isCurrent()) return;
    if (canonicalIdentityGenerationChanged(indexKey, expectedIdentityGeneration)) return;
    const trackId = canonicalizeConfirmedNavidromeId(indexKey, previousTrackId);
    if (keepIds.has(trackId)) continue;
    if (trackStillNeededByOtherPin(trackId, indexKey, kind, sourceId)) continue;

    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (!entry?.localPath || entry.tier !== 'library') continue;
    if (entry.pinSource?.kind !== kind || entry.pinSource.sourceId !== sourceId) continue;

    if (!isCurrent() || canonicalIdentityGenerationChanged(indexKey, expectedIdentityGeneration)) return;
    await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
    const [stillExists] = await probeMediaFiles({ localPaths: [entry.localPath] }).catch(() => [true]);
    if (stillExists) continue;
    const currentEntry = findLocalPlaybackEntry(entry.trackId, serverId);
    const identityChanged = canonicalIdentityGenerationChanged(indexKey, expectedIdentityGeneration);
    if (currentEntry !== entry && (!identityChanged || currentEntry?.localPath !== entry.localPath)) continue;
    if (!currentEntry) continue;
    useLocalPlaybackStore.getState().removeEntry(
      currentEntry.trackId,
      currentEntry.serverIndexKey,
      `${kind}-sync-prune`,
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
  const activeSourceId = canonicalizeConfirmedNavidromeId(indexKey, sourceId);
  const activeCoverArt = patch.coverArt
    ? canonicalizeConfirmedNavidromeId(indexKey, patch.coverArt)
    : patch.coverArt;
  const activeTrackIds = [...new Set(
    patch.trackIds.map(id => canonicalizeConfirmedNavidromeId(indexKey, id)),
  )];
  useOfflineStore.setState(state => {
    const key = `${indexKey}:${activeSourceId}`;
    const rawIndexKey = `${indexKey}:${sourceId}`;
    const rawProfileKey = `${serverId}:${sourceId}`;
    const canonicalProfileKey = `${serverId}:${activeSourceId}`;
    const existing = state.albums[key]
      ?? state.albums[rawIndexKey]
      ?? state.albums[canonicalProfileKey]
      ?? state.albums[rawProfileKey];
    const nextAlbums = { ...state.albums };
    delete nextAlbums[rawIndexKey];
    delete nextAlbums[rawProfileKey];
    delete nextAlbums[canonicalProfileKey];
    nextAlbums[key] = {
      ...(existing ?? {
        id: activeSourceId,
        serverId: indexKey,
        artist: patch.albumArtist,
      }),
      id: activeSourceId,
      serverId: indexKey,
      name: patch.name,
      artist: patch.albumArtist,
      coverArt: activeCoverArt ?? (existing?.coverArt
        ? canonicalizeConfirmedNavidromeId(indexKey, existing.coverArt)
        : existing?.coverArt),
      year: patch.year ?? existing?.year,
      trackIds: activeTrackIds,
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

function scheduleArtistRetryWhileDownloading(
  artistId: string,
  serverId: string,
  albumIds?: string[],
): void {
  const key = `${serverId}:artist-scope:${artistId}`;
  const prev = retryTimers.get(key);
  if (prev) clearTimeout(prev);
  retryTimers.set(key, setTimeout(() => {
    retryTimers.delete(key);
    void syncPinnedArtistIfNeeded(artistId, serverId, albumIds);
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
  if (syncPauseDepth > 0) return;
  if (!isActiveServerReachable()) return;
  const alreadyPinned = isSourcePinnedOffline(sourceId, serverId, kind);
  if (!alreadyPinned && !options.allowUnpinned) return;
  if (kind === 'playlist' && !isManualOfflinePlaylist(sourceId, serverId, options.name)) return;
  const identityOwner = serverIndexKeyForOffline(serverId);
  const identityGeneration = canonicalIdentityGeneration(identityOwner);
  const sourceSync = beginSourceSync(sourceId, serverId, kind);

  let songs = options.prefetchedSongs;
  let displayName = options.name ?? offlineMeta(sourceId, serverId)?.name ?? sourceId;
  let albumArtist = options.albumArtist ?? offlineMeta(sourceId, serverId)?.artist ?? '';
  let coverArt = options.coverArt ?? offlineMeta(sourceId, serverId)?.coverArt;
  let year = options.year ?? offlineMeta(sourceId, serverId)?.year;

  try {
    if (!songs) {
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
    } else {
      songs = await filterSongsToServerLibrary(songs, serverId);
    }
  } catch {
    sourceSync.abandon();
    return;
  }

  const indexKey = serverIndexKeyForOffline(serverId);
  const activeSourceId = canonicalizeConfirmedNavidromeId(indexKey, sourceId);
  const activeTask = canonicalizeOfflinePinTask({
    albumId: activeSourceId,
    albumName: displayName,
    albumArtist,
    coverArt,
    year,
    songs: dedupeSongs(songs),
    serverId,
    type: kind,
    artistProgressGroupId: options.artistProgressGroupId,
  }, indexKey);
  const unique = activeTask.songs;
  const keepIds = new Set(unique.map(s => s.id));

  await runSourceMutation(sourceSync.key, async () => {
    if (!sourceSync.isCurrent()) return;
    const offline = useOfflineStore.getState();
    if (offline.isAlbumDownloading(activeSourceId, serverId)) {
      scheduleRetryWhileDownloading(activeSourceId, serverId, kind);
      return;
    }
    await pruneRemovedPinTracks(
      sourceId,
      serverId,
      kind,
      keepIds,
      identityGeneration,
      sourceSync.isCurrent,
    );
    if (!sourceSync.isCurrent()) return;
    updateOfflineMeta(sourceId, serverId, kind, {
      name: displayName,
      albumArtist,
      coverArt,
      year,
      trackIds: unique.map(s => s.id),
    });

    if (!sourceSync.isCurrent()) return;
    const enqueued = enqueueOfflinePin(activeTask);
    if (!enqueued && offline.isAlbumDownloading(activeSourceId, serverId)) {
      scheduleRetryWhileDownloading(activeSourceId, serverId, kind);
    }
  });
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
  if (syncPauseDepth > 0) return;
  const lifecycle = sourceSyncLifecycle;
  const lifecycleIsCurrent = () => sourceSyncLifecycle === lifecycle;
  if (!isActiveServerReachable()) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !artistId) return;

  const pinnedBefore = listPinnedArtistAlbumIds(sid);
  const scopeIds = knownAlbumIds ?? pinnedBefore;
  if (!isArtistDiscographyPinnedOffline(sid, scopeIds) && pinnedBefore.length === 0) return;
  const identityOwner = serverIndexKeyForOffline(sid);
  const identityGeneration = canonicalIdentityGeneration(identityOwner);

  let liveAlbumIds: string[];
  try {
    const { albums } = await getArtistForServer(sid, artistId);
    liveAlbumIds = albums.map(a => a.id);
  } catch {
    return;
  }
  if (!lifecycleIsCurrent()) return;

  const scopeFullyPinned = scopeIds.length > 0
    && scopeIds.every(id => isSourcePinnedOffline(id, sid, 'artist'));
  const liveSet = new Set(liveAlbumIds);

  for (const oldAlbumId of canonicalIdentityGenerationChanged(identityOwner, identityGeneration)
    ? []
    : pinnedBefore) {
    if (!lifecycleIsCurrent()) return;
    if (liveSet.has(oldAlbumId)) continue;
    if (useOfflineStore.getState().isAlbumDownloading(oldAlbumId, sid)) {
      scheduleArtistRetryWhileDownloading(artistId, sid, scopeIds);
      continue;
    }
    const mutationKey = `${identityOwner}:artist:${canonicalizeNavidromeId(oldAlbumId)}`;
    await runSourceMutation(mutationKey, async () => {
      await pruneRemovedPinTracks(
        oldAlbumId,
        sid,
        'artist',
        new Set(),
        identityGeneration,
        lifecycleIsCurrent,
      );
      if (!lifecycleIsCurrent()) return;
      if (canonicalIdentityGenerationChanged(identityOwner, identityGeneration)) return;
      const indexKey = serverIndexKeyForOffline(sid);
      useOfflineStore.setState(state => {
        const albums = { ...state.albums };
        delete albums[`${indexKey}:${oldAlbumId}`];
        delete albums[`${sid}:${oldAlbumId}`];
        return { albums };
      });
    });
    if (!lifecycleIsCurrent()) return;
    if (canonicalIdentityGenerationChanged(identityOwner, identityGeneration)) break;
  }

  for (const albumId of liveAlbumIds) {
    if (!lifecycleIsCurrent()) return;
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
  if (syncPauseDepth > 0) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!playlistId || !sid) return;
  if (!isSourcePinnedOffline(playlistId, sid, 'playlist')) return;
  if (!isManualOfflinePlaylist(playlistId, sid)) return;
  if (!isActiveServerReachable()) return;
  pushUniquePlaylistJob(playlistId, sid);
  scheduleDebouncedPlaylistSync();
}

export function schedulePinnedAlbumSync(albumId: string, serverId?: string): void {
  if (syncPauseDepth > 0) return;
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
  if (syncPauseDepth > 0) return;
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid || !artistId) return;
  if (!isArtistDiscographyPinnedOffline(sid, albumIds ?? listPinnedArtistAlbumIds(sid))) return;
  if (!isActiveServerReachable()) return;
  pushUniqueArtistJob(artistId, sid, albumIds);
  scheduleDebouncedAlbumArtistSync();
}

/** Reconcile every cached album pin and artist discography (optionally one server). */
export async function syncAllPinnedAlbumsAndArtists(serverId?: string): Promise<void> {
  if (syncPauseDepth > 0) return;
  const lifecycle = sourceSyncLifecycle;
  const lifecycleIsCurrent = () => sourceSyncLifecycle === lifecycle;
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
    if (!lifecycleIsCurrent()) return;
    await syncPinnedSourceIfNeeded(job.sourceId, job.serverId, 'album');
  }

  for (const [sid, albumIds] of artistAlbumIdsByServer) {
    if (!lifecycleIsCurrent()) return;
    const byArtist = await groupPinnedArtistAlbumsByArtistId(sid, albumIds);
    if (!lifecycleIsCurrent()) return;
    const assignedAlbums = new Set<string>();
    for (const [artistId, ids] of byArtist) {
      if (!lifecycleIsCurrent()) return;
      ids.forEach(id => assignedAlbums.add(id));
      await syncPinnedArtistIfNeeded(artistId, sid, ids);
    }
    for (const albumId of albumIds) {
      if (!lifecycleIsCurrent()) return;
      if (assignedAlbums.has(albumId)) continue;
      await syncPinnedSourceIfNeeded(albumId, sid, 'artist');
    }
  }
}

/** Reconcile every manually cached regular playlist (optionally one server). */
export async function syncAllPinnedPlaylists(serverId?: string): Promise<void> {
  if (syncPauseDepth > 0) return;
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
  if (syncPauseDepth > 0) return;
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
  if (syncPauseDepth > 0) return;
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

export async function pauseAndDrainPinnedOfflineSync(): Promise<void> {
  syncPauseDepth += 1;
  if (syncPauseDepth > 1) return;
  sourceSyncLifecycle += 1;
  if (playlistDebounceTimer) clearTimeout(playlistDebounceTimer);
  if (albumArtistDebounceTimer) clearTimeout(albumArtistDebounceTimer);
  playlistDebounceTimer = null;
  albumArtistDebounceTimer = null;
  pendingPlaylistJobs.length = 0;
  pendingAlbumJobs.length = 0;
  pendingArtistJobs.length = 0;
  pendingAlbumArtistServers.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  await Promise.allSettled([...sourceMutationTail.values()]);
}

export function resumePinnedOfflineSync(): void {
  if (syncPauseDepth === 0) return;
  syncPauseDepth -= 1;
  if (syncPauseDepth > 0) return;
  scheduleSyncPinnedAlbumsAndArtists();
  void syncAllPinnedPlaylists();
}

export function initPinnedOfflineSync(): () => void {
  let disposed = false;
  void subscribeLibrarySyncIdle(payload => {
    if (disposed) return;
    onLibraryBecameIdle(payload.serverId, payload.kind, payload.ok);
  }).then(unlisten => {
    if (disposed) {
      unlisten();
      return;
    }
    stopLibraryIdle = unlisten;
  });

  playlistSyncInterval = setInterval(() => {
    if (isActiveServerReachable()) void syncAllPinnedPlaylists();
  }, PLAYLIST_SYNC_INTERVAL_MS);

  const stopReachable = onActiveServerBecameReachable(() => {
    scheduleSyncPinnedAlbumsAndArtists();
  });

  return () => {
    disposed = true;
    sourceSyncLifecycle += 1;
    if (playlistDebounceTimer) clearTimeout(playlistDebounceTimer);
    if (albumArtistDebounceTimer) clearTimeout(albumArtistDebounceTimer);
    pendingPlaylistJobs.length = 0;
    pendingAlbumJobs.length = 0;
    pendingArtistJobs.length = 0;
    pendingAlbumArtistServers.clear();
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
