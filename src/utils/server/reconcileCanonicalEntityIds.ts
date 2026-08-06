import type { Track } from '@/lib/media/trackTypes';
import {
  libraryIdentityTransitionAck,
  libraryIdentityTransitionProbe,
  libraryIdentityTransitionRunNativeMigration,
  libraryIdentityTransitionStatus,
  type IdentityProbeCandidateDto,
} from '@/lib/api/library';
import { analysisClearServerCache } from '@/lib/api/analysis';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore, type LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { useOfflineStore, type OfflineAlbumMeta } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  readShuffleModeSnapshot,
  persistShuffleModeSnapshot,
  type ShuffleModeSnapshot,
} from '@/features/playback/store/shuffleModeStorage';
import { setShuffleOriginalOrder } from '@/features/playback/store/shuffleModeActions';
import { useDeviceSyncStore, deviceSyncSourceKey } from '@/features/deviceSync';
import {
  invalidatePlaylistRequestsForIdentityTransition,
  usePlaylistFolderStore,
  usePlaylistStore,
} from '@/features/playlist';
import { clearLyricsCache } from '@/features/lyrics/utils/lyricsPersistentCache';
import type { ServerProfile } from '@/store/authStoreTypes';
import { useMigrationStore } from '@/store/migrationStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { mergeLocalPlaybackEntry, mergeOfflineAlbum } from './rewriteFrontendStoreKeys';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
} from '@/lib/server/navidromeCanonicalIds';

const reconciliationInFlight = new Map<string, Promise<void>>();
let canonicalMigrationSerial: Promise<void> = Promise.resolve();
let retryRequest: { server: ServerProfile; serverIndexKey: string } | null = null;

export { canonicalizeNavidromeId } from '@/lib/server/navidromeCanonicalIds';

function isOwnedBy(serverId: string | null | undefined, owners: Set<string>): boolean {
  return !!serverId && owners.has(serverId);
}

function canonicalizeTrack(track: Track): Track {
  return {
    ...track,
    id: canonicalizeNavidromeId(track.id),
    albumId: canonicalizeNavidromeId(track.albumId),
    artistId: track.artistId ? canonicalizeNavidromeId(track.artistId) : track.artistId,
    coverArt: track.coverArt ? canonicalizeNavidromeId(track.coverArt) : track.coverArt,
    artists: track.artists?.map(artist => ({
      ...artist,
      id: artist.id ? canonicalizeNavidromeId(artist.id) : artist.id,
    })),
  };
}

function canonicalizeOfflineAlbum(meta: OfflineAlbumMeta): OfflineAlbumMeta {
  return {
    ...meta,
    id: canonicalizeNavidromeId(meta.id),
    coverArt: meta.coverArt ? canonicalizeNavidromeId(meta.coverArt) : meta.coverArt,
    trackIds: [...new Set(meta.trackIds.map(canonicalizeNavidromeId))],
  };
}

async function ensureHydrated(): Promise<void> {
  await Promise.all([
    useAuthStore.persist.hasHydrated() ? undefined : useAuthStore.persist.rehydrate(),
    usePlayerStore.persist.hasHydrated() ? undefined : usePlayerStore.persist.rehydrate(),
    useLocalPlaybackStore.persist.hasHydrated() ? undefined : useLocalPlaybackStore.persist.rehydrate(),
    useOfflineStore.persist.hasHydrated() ? undefined : useOfflineStore.persist.rehydrate(),
    useDeviceSyncStore.persist.hasHydrated() ? undefined : useDeviceSyncStore.persist.rehydrate(),
    usePlaylistStore.persist.hasHydrated() ? undefined : usePlaylistStore.persist.rehydrate(),
    usePlaylistFolderStore.persist.hasHydrated() ? undefined : usePlaylistFolderStore.persist.rehydrate(),
  ]);
}

function collectProbeCandidates(owners: Set<string>): IdentityProbeCandidateDto[] {
  const tracks = new Set<string>();
  const albums = new Set<string>();
  const add = (target: Set<string>, id: string | null | undefined): void => {
    if (id && canonicalizeNavidromeId(id) !== id) target.add(id);
  };
  const player = usePlayerStore.getState();
  const currentOwner = player.currentTrack?.serverId ?? player.queueServerId;
  if (player.currentTrack && isOwnedBy(currentOwner, owners)) {
    add(tracks, player.currentTrack.id);
    add(albums, player.currentTrack.albumId);
  }
  for (const item of player.queueItems) {
    if (isOwnedBy(item.serverId, owners)) add(tracks, item.trackId);
  }
  for (const entry of Object.values(useLocalPlaybackStore.getState().entries)) {
    if (!owners.has(entry.serverIndexKey)) continue;
    add(tracks, entry.trackId);
    if (entry.pinSource?.kind === 'album') add(albums, entry.pinSource.sourceId);
  }
  for (const album of Object.values(useOfflineStore.getState().albums)) {
    if (!owners.has(album.serverId)) continue;
    add(albums, album.id);
    for (const trackId of album.trackIds) add(tracks, trackId);
  }
  for (const source of useDeviceSyncStore.getState().sources) {
    if (!owners.has(source.serverIndexKey)) continue;
    if (source.type === 'album') add(albums, source.id);
  }
  return [
    ...[...tracks].slice(0, 4).map(id => ({ entityKind: 'track' as const, id })),
    ...[...albums].slice(0, 4).map(id => ({ entityKind: 'album' as const, id })),
  ];
}

function rewritePlayer(owners: Set<string>): ShuffleModeSnapshot {
  usePlayerStore.setState(state => {
    const currentOwner = state.currentTrack?.serverId ?? state.queueServerId;
    const currentTrack = state.currentTrack && isOwnedBy(currentOwner, owners)
      ? canonicalizeTrack(state.currentTrack)
      : state.currentTrack;
    const queueItems = state.queueItems.map(item => isOwnedBy(item.serverId, owners)
      ? { ...item, trackId: canonicalizeNavidromeId(item.trackId) }
      : item);
    return { currentTrack, queueItems };
  });

  const shuffle = readShuffleModeSnapshot();
  if (!shuffle.enabled) return shuffle;
  const originalOrder = shuffle.originalOrder.map(identity => {
    try {
      const parsed = JSON.parse(identity) as unknown;
      if (
        Array.isArray(parsed)
        && parsed.length === 2
        && typeof parsed[0] === 'string'
        && typeof parsed[1] === 'string'
        && owners.has(parsed[0])
      ) {
        return JSON.stringify([parsed[0], canonicalizeNavidromeId(parsed[1])]);
      }
    } catch {
      // Legacy ownerless identities cannot be assigned safely here.
    }
    return identity;
  });
  const rewritten = { ...shuffle, originalOrder };
  setShuffleOriginalOrder(originalOrder);
  persistShuffleModeSnapshot(rewritten);
  return rewritten;
}

function rewriteLocalPlayback(owners: Set<string>, serverIndexKey: string): void {
  useLocalPlaybackStore.setState(state => {
    const entries = { ...state.entries };
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!owners.has(entry.serverIndexKey)) continue;
      const trackId = canonicalizeNavidromeId(entry.trackId);
      const nextKey = `${serverIndexKey}:${trackId}`;
      const incoming: LocalPlaybackEntry = {
        ...entry,
        serverIndexKey,
        trackId,
        pinSource: entry.pinSource ? {
          ...entry.pinSource,
          sourceId: canonicalizeNavidromeId(entry.pinSource.sourceId),
        } : undefined,
      };
      const existing = entries[nextKey];
      entries[nextKey] = existing
        ? mergeLocalPlaybackEntry(existing, incoming, serverIndexKey)
        : incoming;
      if (key !== nextKey) delete entries[key];
    }
    return { entries };
  });
}

function rewriteOffline(owners: Set<string>, serverIndexKey: string): void {
  useOfflineStore.setState(state => {
    const albums = { ...state.albums };
    for (const [key, meta] of Object.entries(state.albums)) {
      if (!owners.has(meta.serverId)) continue;
      const incoming = { ...canonicalizeOfflineAlbum(meta), serverId: serverIndexKey };
      const nextKey = `${serverIndexKey}:${incoming.id}`;
      const existing = albums[nextKey];
      albums[nextKey] = existing
        ? mergeOfflineAlbum(existing, incoming, serverIndexKey)
        : incoming;
      if (key !== nextKey) delete albums[key];
    }
    return { albums };
  });
}

function rewriteAuthState(owners: Set<string>): void {
  useAuthStore.setState(state => {
    const rewriteFolders = (folders: Array<{ id: string; name: string }>) => folders.map(folder => ({
      ...folder,
      id: canonicalizeNavidromeId(folder.id),
    }));
    const musicFoldersByServer = { ...state.musicFoldersByServer };
    const libraryBrowseSelectionByServer = { ...state.libraryBrowseSelectionByServer };
    const musicLibraryFilterByServer = { ...state.musicLibraryFilterByServer };
    const musicLibrarySelectionByServer = { ...state.musicLibrarySelectionByServer };
    for (const owner of owners) {
      if (musicFoldersByServer[owner]) {
        musicFoldersByServer[owner] = rewriteFolders(musicFoldersByServer[owner]);
      }
      if (libraryBrowseSelectionByServer[owner]) {
        libraryBrowseSelectionByServer[owner] = libraryBrowseSelectionByServer[owner]
          .map(canonicalizeNavidromeId);
      }
      const filter = musicLibraryFilterByServer[owner];
      if (filter && filter !== 'all') {
        musicLibraryFilterByServer[owner] = canonicalizeNavidromeId(filter);
      }
      if (musicLibrarySelectionByServer[owner]) {
        musicLibrarySelectionByServer[owner] = musicLibrarySelectionByServer[owner]
          .map(canonicalizeNavidromeId);
      }
    }
    const musicFolders = owners.has(state.activeServerId ?? '')
      ? rewriteFolders(state.musicFolders)
      : state.musicFolders;
    return {
      skipStarManualSkipCountsByKey: {},
      musicFolders,
      musicFoldersByServer,
      libraryBrowseSelectionByServer,
      musicLibraryFilterByServer,
      musicLibrarySelectionByServer,
    };
  });
}

function rewriteDeviceSync(owners: Set<string>, serverIndexKey: string): void {
  const legacySources = useDeviceSyncStore.getState().legacySources;
  if (legacySources.length > 0) {
    throw new Error(
      'Device Sync has ownerless legacy selections. Open Device Sync and add a source to recover them, then retry.',
    );
  }
  useDeviceSyncStore.setState(state => {
    const byKey = new Map<string, (typeof state.sources)[number]>();
    for (const source of state.sources) {
      const next = owners.has(source.serverIndexKey)
        ? { ...source, serverIndexKey, id: canonicalizeNavidromeId(source.id) }
        : source;
      byKey.set(deviceSyncSourceKey(next), next);
    }
    return { sources: [...byKey.values()] };
  });
}

function rewritePlaylists(owners: Set<string>): void {
  // The playlist list and recency metadata are server-derived caches. Drop
  // them instead of carrying more migration rules; the next page visit refetches.
  usePlaylistStore.setState({
    playlists: [],
    recentIds: [],
    lastModified: {},
    playlistsLoading: false,
  });
  usePlaylistMembershipStore.getState().clearAllPlaylistSongIds();

  usePlaylistFolderStore.setState(state => {
    const byServer = { ...state.byServer };
    for (const owner of owners) {
      const server = byServer[owner];
      if (!server) continue;
      const assignments: Record<string, string> = {};
      for (const [playlistId, folderId] of Object.entries(server.assignments)) {
        assignments[canonicalizeNavidromeId(playlistId)] ??= folderId;
      }
      byServer[owner] = { ...server, assignments };
    }
    return { byServer };
  });
}

function persistedState(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error(`canonical-ID reconciliation did not persist ${key}`);
  const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
  if (!parsed.state) throw new Error(`canonical-ID reconciliation found invalid ${key}`);
  return parsed.state;
}

function verifyPersistence(expectedShuffle: ShuffleModeSnapshot): void {
  const checks: Array<[string, string, unknown]> = [
    ['psysonic-player', 'currentTrack', usePlayerStore.getState().currentTrack],
    ['psysonic-player', 'queueItems', usePlayerStore.getState().queueItems],
    ['psysonic-local-playback', 'entries', useLocalPlaybackStore.getState().entries],
    ['psysonic-offline', 'albums', useOfflineStore.getState().albums],
    ['psysonic-auth', 'musicFoldersByServer', useAuthStore.getState().musicFoldersByServer],
    ['psysonic-auth', 'libraryBrowseSelectionByServer', useAuthStore.getState().libraryBrowseSelectionByServer],
    ['psysonic-auth', 'musicLibraryFilterByServer', useAuthStore.getState().musicLibraryFilterByServer],
    ['psysonic-auth', 'musicLibrarySelectionByServer', useAuthStore.getState().musicLibrarySelectionByServer],
    ['psysonic_device_sync', 'sources', useDeviceSyncStore.getState().sources],
    ['psysonic_device_sync', 'legacySources', useDeviceSyncStore.getState().legacySources],
    ['psysonic_playlists_recent', 'playlists', usePlaylistStore.getState().playlists],
    ['psysonic_playlists_recent', 'recentIds', usePlaylistStore.getState().recentIds],
    ['psysonic_playlists_recent', 'lastModified', usePlaylistStore.getState().lastModified],
    ['psysonic_playlist_folders', 'byServer', usePlaylistFolderStore.getState().byServer],
  ];
  for (const [storageKey, field, expected] of checks) {
    const actual = persistedState(storageKey)[field];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`canonical-ID reconciliation could not verify ${storageKey}.${field}`);
    }
  }
  if (JSON.stringify(readShuffleModeSnapshot()) !== JSON.stringify(expectedShuffle)) {
    throw new Error('canonical-ID reconciliation could not verify shuffle state');
  }
}

function assertCanonicalOwnedState(owners: Set<string>): void {
  const legacyIds: string[] = [];
  const check = (label: string, id: string | null | undefined): void => {
    if (id && canonicalizeNavidromeId(id) !== id) legacyIds.push(`${label}:${id}`);
  };
  const player = usePlayerStore.getState();
  const currentOwner = player.currentTrack?.serverId ?? player.queueServerId;
  if (player.currentTrack && isOwnedBy(currentOwner, owners)) {
    check('currentTrack', player.currentTrack.id);
    check('currentAlbum', player.currentTrack.albumId);
    check('currentArtist', player.currentTrack.artistId);
  }
  for (const item of player.queueItems) {
    if (isOwnedBy(item.serverId, owners)) check('queue', item.trackId);
  }
  for (const entry of Object.values(useLocalPlaybackStore.getState().entries)) {
    if (!owners.has(entry.serverIndexKey)) continue;
    check('localPlayback', entry.trackId);
    check('localPlaybackSource', entry.pinSource?.sourceId);
  }
  for (const album of Object.values(useOfflineStore.getState().albums)) {
    if (!owners.has(album.serverId)) continue;
    check('offlineAlbum', album.id);
    for (const trackId of album.trackIds) check('offlineTrack', trackId);
  }
  const auth = useAuthStore.getState();
  if (owners.has(auth.activeServerId ?? '')) {
    for (const folder of auth.musicFolders) check('activeMusicFolder', folder.id);
  }
  for (const owner of owners) {
    for (const folder of auth.musicFoldersByServer[owner] ?? []) check('musicFolder', folder.id);
    for (const folderId of auth.libraryBrowseSelectionByServer[owner] ?? []) check('browseFolder', folderId);
    for (const folderId of auth.musicLibrarySelectionByServer[owner] ?? []) check('libraryFolder', folderId);
    const filter = auth.musicLibraryFilterByServer[owner];
    if (filter && filter !== 'all') check('libraryFilter', filter);
  }
  const device = useDeviceSyncStore.getState();
  if (device.legacySources.length > 0) legacyIds.push('deviceSync:ownerless');
  for (const source of device.sources) {
    if (owners.has(source.serverIndexKey)) check('deviceSync', source.id);
  }
  for (const owner of owners) {
    const folders = usePlaylistFolderStore.getState().byServer[owner];
    for (const playlistId of Object.keys(folders?.assignments ?? {})) check('playlistFolder', playlistId);
  }
  if (legacyIds.length > 0) {
    throw new Error(`Canonical-ID reconciliation left legacy references: ${legacyIds.slice(0, 5).join(', ')}`);
  }
}

async function runCanonicalIdentityTransition(
  server: ServerProfile,
  serverIndexKey: string,
): Promise<void> {
  await ensureHydrated();
  const owners = new Set([
    server.id,
    serverIndexKey,
    ...useAuthStore.getState().servers
      .filter(profile => serverIndexKeyForProfile(profile) === serverIndexKey)
      .map(profile => profile.id),
  ]);
  let status = await libraryIdentityTransitionStatus(serverIndexKey);
  const probeCandidates = collectProbeCandidates(owners);
  if (
    status.state === 'unseen'
    || status.state === 'awaiting_supplemental_probe'
    || status.state === 'retryable'
  ) {
    status = await libraryIdentityTransitionProbe(serverIndexKey, probeCandidates);
  }
  if (status.state === 'ready') {
    activateCanonicalNavidromeOwners(owners);
    return;
  }
  if (status.state === 'legacy' || status.state === 'no_legacy_ids') return;
  if (status.state === 'retryable' || status.state === 'awaiting_supplemental_probe') {
    throw new Error(status.lastError ?? 'Canonical-ID probe remains inconclusive');
  }

  const migration = useMigrationStore.getState();
  retryRequest = { server, serverIndexKey };
  migration.setStep('canonicalIds');
  migration.setNeedsMigration(true);
  migration.setError(null);
  migration.setPhase('running');

  try {
    if (status.state === 'blocked') {
      throw new Error(status.lastError ?? 'Canonical-ID transition is blocked');
    }
    if (status.state === 'transition_detected') {
      status = await libraryIdentityTransitionRunNativeMigration(serverIndexKey);
    }
    if (status.state !== 'pending_frontend') {
      throw new Error(`Unexpected canonical-ID transition state: ${status.state}`);
    }

    activateCanonicalNavidromeOwners(owners);
    invalidatePlaylistRequestsForIdentityTransition();
    await analysisClearServerCache(serverIndexKey);
    await clearLyricsCache();
    const expectedShuffle = rewritePlayer(owners);
    rewriteLocalPlayback(owners, serverIndexKey);
    rewriteOffline(owners, serverIndexKey);
    rewriteAuthState(owners);
    rewriteDeviceSync(owners, serverIndexKey);
    rewritePlaylists(owners);
    assertCanonicalOwnedState(owners);
    verifyPersistence(expectedShuffle);
    await libraryIdentityTransitionAck(serverIndexKey);

    retryRequest = null;
    migration.setNeedsMigration(false);
    migration.setStep(null);
    migration.setPhase('completed');
  } catch (error) {
    migration.setError(error instanceof Error ? error.message : String(error));
    migration.setPhase('error');
    throw error;
  }
}

export async function reconcileCanonicalEntityIds(
  server: ServerProfile,
  serverIndexKey: string,
): Promise<void> {
  const existing = reconciliationInFlight.get(serverIndexKey);
  if (existing) return existing;
  const promise = canonicalMigrationSerial
    .catch(() => undefined)
    .then(() => runCanonicalIdentityTransition(server, serverIndexKey));
  canonicalMigrationSerial = promise.catch(() => undefined);
  const tracked = promise.finally(() => {
    reconciliationInFlight.delete(serverIndexKey);
  });
  reconciliationInFlight.set(serverIndexKey, tracked);
  return tracked;
}

export function retryCanonicalIdentityMigration(): void {
  const request = retryRequest;
  if (!request) return;
  void reconcileCanonicalEntityIds(request.server, request.serverIndexKey).catch(() => {});
}
