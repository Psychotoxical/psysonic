import { invoke } from '@tauri-apps/api/core';
import type {
  CanonicalIdMappingDto,
  CanonicalMigrationDto,
} from '@/lib/api/library';
import type {
  InternetRadioStation,
  SubsonicOpenArtistRef,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { canonicalNavidromeArtworkId, canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { resolveStorageServerIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore, type LocalPlaybackEntry, type PinSource } from '@/store/localPlaybackStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useOfflineStore, type OfflineAlbumMeta } from '@/features/offline';
import { useDeviceSyncStore, type DeviceSyncSource } from '@/features/deviceSync';
import type { DeviceSyncManifest, LegacyDeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { NEW_RELEASES_UNREAD_STORAGE_PREFIX } from '@/features/sidebar/utils/sidebarHelpers';
import { setShuffleOriginalOrder } from '@/features/playback/store/shuffleModeActions';

type EntityKind = 'artist' | 'album' | 'track' | 'folder';
type EntityMaps = Record<EntityKind, Map<string, string>>;

const PLAYER_KEY = 'psysonic-player';
const SHUFFLE_KEY = 'psysonic_shuffle_mode';
const PLAYLIST_KEY = 'psysonic_playlists_recent';
const RADIO_KEYS = ['psysonic_radio_favorites', 'psysonic_radio_order'] as const;

function buildMaps(mappings: readonly CanonicalIdMappingDto[]): EntityMaps {
  const maps: EntityMaps = {
    artist: new Map(),
    album: new Map(),
    track: new Map(),
    folder: new Map(),
  };
  for (const mapping of mappings) {
    const kind = mapping.entityKind as EntityKind;
    if (maps[kind]) maps[kind].set(mapping.oldId, mapping.newId);
  }
  return maps;
}

function mapId(maps: EntityMaps, kind: EntityKind, value: string | undefined): string | undefined {
  return value ? maps[kind].get(value) ?? canonicalNavidromeId(value) : value;
}

function rewriteArtistRefs(
  refs: SubsonicOpenArtistRef[] | undefined,
  maps: EntityMaps,
): SubsonicOpenArtistRef[] | undefined {
  return refs?.map(ref => ({ ...ref, id: mapId(maps, 'artist', ref.id) }));
}

function rewriteTrack<T extends Track | SubsonicSong>(track: T, maps: EntityMaps): T {
  const song = track as SubsonicSong;
  return {
    ...track,
    id: mapId(maps, 'track', track.id)!,
    albumId: mapId(maps, 'album', track.albumId)!,
    artistId: mapId(maps, 'artist', track.artistId),
    artists: rewriteArtistRefs(track.artists, maps),
    coverArt: track.coverArt ? canonicalNavidromeArtworkId(track.coverArt) : undefined,
    ...(song.albumArtists ? { albumArtists: rewriteArtistRefs(song.albumArtists, maps) } : {}),
    ...(song.contributors ? {
      contributors: song.contributors.map(contributor => ({
        ...contributor,
        artist: {
          ...contributor.artist,
          id: mapId(maps, 'artist', contributor.artist.id),
        },
      })),
    } : {}),
  };
}

function rewritePinSource(source: PinSource | undefined, maps: EntityMaps): PinSource | undefined {
  if (!source) return undefined;
  const kind: EntityKind = source.kind === 'track' ? 'track' : 'album';
  return { ...source, sourceId: mapId(maps, kind, source.sourceId)! };
}

function rewriteOwnedKey(value: string, ownerId: string): string {
  const prefix = `${ownerId}:`;
  if (!value.startsWith(prefix)) return value;
  return `${prefix}${canonicalNavidromeId(value.slice(prefix.length))}`;
}

function isOwnedBy(value: string | null | undefined, owners: ReadonlySet<string>): boolean {
  return Boolean(value && owners.has(value));
}

function readJson(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Malformed persisted state in ${key}`);
  }
}

function rewriteRawPlayerState(owners: ReadonlySet<string>, maps: EntityMaps): void {
  const root = readJson(PLAYER_KEY) as { state?: Record<string, unknown>; version?: number } | null;
  if (!root?.state) return;
  const state = root.state;
  const currentTrack = state.currentTrack as Track | null | undefined;
  if (currentTrack && (isOwnedBy(currentTrack.serverId, owners)
    || (!currentTrack.serverId && isOwnedBy(state.queueServerId as string | undefined, owners)))) {
    if (currentTrack) state.currentTrack = rewriteTrack(currentTrack, maps);
  }
  if (Array.isArray(state.queueItems)) {
    state.queueItems = state.queueItems.map((item: unknown) => {
      const ref = item as { serverId?: string; trackId?: string };
      return isOwnedBy(ref.serverId, owners) && typeof ref.trackId === 'string'
        ? { ...ref, trackId: mapId(maps, 'track', ref.trackId) }
        : ref;
    });
  }
  if (Array.isArray(state.queueRefs) && isOwnedBy(state.queueServerId as string | undefined, owners)) {
    state.queueRefs = state.queueRefs.map((id: unknown) => (
      typeof id === 'string' ? mapId(maps, 'track', id) : id
    ));
  }
  if (Array.isArray(state.queue) && isOwnedBy(state.queueServerId as string | undefined, owners)) {
    state.queue = state.queue.map((track: unknown) => rewriteTrack(track as Track, maps));
  }
  localStorage.setItem(PLAYER_KEY, JSON.stringify(root));
}

function rewriteShuffleState(serverId: string, maps: EntityMaps): void {
  const snapshot = readJson(SHUFFLE_KEY) as { enabled?: boolean; originalOrder?: unknown[] } | null;
  if (!snapshot?.originalOrder) return;
  snapshot.originalOrder = snapshot.originalOrder.map(value => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== serverId || typeof parsed[1] !== 'string') {
        return value;
      }
      return JSON.stringify([serverId, mapId(maps, 'track', parsed[1])]);
    } catch {
      return mapId(maps, 'track', value);
    }
  });
  setShuffleOriginalOrder(snapshot.originalOrder.filter((value): value is string => typeof value === 'string'));
  localStorage.setItem(SHUFFLE_KEY, JSON.stringify(snapshot));
}

function rewriteRadioState(profileId: string): void {
  for (const key of RADIO_KEYS) {
    const values = readJson(key);
    if (!Array.isArray(values)) continue;
    localStorage.setItem(key, JSON.stringify([
      ...new Set(values.map(value => typeof value === 'string' ? rewriteOwnedKey(value, profileId) : value)),
    ]));
  }
}

function rewriteAuthStore(profileId: string, maps: EntityMaps): void {
  useAuthStore.setState(state => {
    const rewriteFolders = (folders: typeof state.musicFolders) => folders.map(folder => ({
      ...folder,
      id: mapId(maps, 'folder', folder.id)!,
    }));
    const rewriteSelection = (values: string[]) => values.map(id => mapId(maps, 'folder', id)!);
    const filter = state.musicLibraryFilterByServer[profileId];
    const skipStarManualSkipCountsByKey: Record<string, number> = {};
    for (const [key, count] of Object.entries(state.skipStarManualSkipCountsByKey)) {
      const separator = key.indexOf('\u001f');
      const owner = separator < 0 ? '' : key.slice(0, separator);
      const trackId = separator < 0 ? key : key.slice(separator + 1);
      const nextKey = owner === profileId
        ? `${owner}\u001f${mapId(maps, 'track', trackId)}`
        : key;
      skipStarManualSkipCountsByKey[nextKey] = Math.max(skipStarManualSkipCountsByKey[nextKey] ?? 0, count);
    }
    return {
      musicFolders: state.activeServerId === profileId
        ? rewriteFolders(state.musicFolders)
        : state.musicFolders,
      musicFoldersByServer: {
        ...state.musicFoldersByServer,
        [profileId]: rewriteFolders(state.musicFoldersByServer[profileId] ?? []),
      },
      libraryBrowseSelectionByServer: {
        ...state.libraryBrowseSelectionByServer,
        [profileId]: rewriteSelection(state.libraryBrowseSelectionByServer[profileId] ?? []),
      },
      musicLibraryFilterByServer: {
        ...state.musicLibraryFilterByServer,
        [profileId]: filter && filter !== 'all' ? mapId(maps, 'folder', filter)! : 'all',
      },
      musicLibrarySelectionByServer: {
        ...state.musicLibrarySelectionByServer,
        [profileId]: rewriteSelection(state.musicLibrarySelectionByServer[profileId] ?? []),
      },
      skipStarManualSkipCountsByKey,
    };
  });
}

function rewriteLocalPlaybackStore(serverId: string, maps: EntityMaps): void {
  useLocalPlaybackStore.setState(state => {
    const entries: Record<string, LocalPlaybackEntry> = {};
    for (const entry of Object.values(state.entries)) {
      const next = entry.serverIndexKey === serverId
        ? {
          ...entry,
          trackId: mapId(maps, 'track', entry.trackId)!,
          pinSource: rewritePinSource(entry.pinSource, maps),
        }
        : entry;
      const key = `${next.serverIndexKey}:${next.trackId}`;
      const existing = entries[key];
      if (existing && existing.localPath !== next.localPath) {
        throw new Error(`Local playback collision at ${key}`);
      }
      if (!existing) {
        entries[key] = next;
        continue;
      }
      const tierPriority = { ephemeral: 0, 'favorite-auto': 1, library: 2 } as const;
      const winner = tierPriority[existing.tier] > tierPriority[next.tier]
        || (tierPriority[existing.tier] === tierPriority[next.tier] && existing.cachedAt >= next.cachedAt)
        ? existing
        : next;
      const other = winner === existing ? next : existing;
      entries[key] = {
        ...winner,
        lastPlayedAt: Math.max(winner.lastPlayedAt ?? 0, other.lastPlayedAt ?? 0) || undefined,
        pinSource: winner.pinSource ?? other.pinSource,
      };
    }
    return { entries };
  });
}

function offlineAlbumKind(meta: OfflineAlbumMeta): EntityKind {
  return meta.type === 'track' ? 'track' : 'album';
}

function rewriteOfflineStore(serverId: string, maps: EntityMaps): void {
  useOfflineStore.setState(state => {
    const albums: Record<string, OfflineAlbumMeta> = {};
    for (const meta of Object.values(state.albums)) {
      const next = meta.serverId === serverId
        ? {
          ...meta,
          id: mapId(maps, offlineAlbumKind(meta), meta.id)!,
          trackIds: meta.trackIds.map(id => mapId(maps, 'track', id)!),
          coverArt: meta.coverArt ? canonicalNavidromeArtworkId(meta.coverArt) : undefined,
        }
        : meta;
      const key = `${next.serverId}:${next.id}`;
      const existing = albums[key];
      albums[key] = existing
        ? { ...next, ...existing, trackIds: [...new Set([...existing.trackIds, ...next.trackIds])] }
        : next;
    }
    return { albums };
  });
}

function rewriteDeviceSource(source: DeviceSyncSource, serverId: string, maps: EntityMaps): DeviceSyncSource {
  if (source.serverIndexKey !== serverId) return source;
  const kind = source.type === 'artist' ? 'artist' : source.type === 'album' ? 'album' : null;
  return { ...source, id: kind ? mapId(maps, kind, source.id)! : canonicalNavidromeId(source.id) };
}

function rewriteLegacyDeviceSource(source: LegacyDeviceSyncSource, serverId: string, maps: EntityMaps): DeviceSyncSource {
  return rewriteDeviceSource({ ...source, serverIndexKey: serverId }, serverId, maps);
}

function dedupeDeviceSources(sources: DeviceSyncSource[]): DeviceSyncSource[] {
  return [...new Map(sources.map(source => [
    JSON.stringify([source.serverIndexKey, source.type, source.id]),
    source,
  ])).values()];
}

function rewriteDeviceSyncStore(serverId: string, maps: EntityMaps): DeviceSyncSource[] {
  const state = useDeviceSyncStore.getState();
  const sources = dedupeDeviceSources([
    ...state.sources.map(source => rewriteDeviceSource(source, serverId, maps)),
    ...state.legacySources.map(source => rewriteLegacyDeviceSource(source, serverId, maps)),
  ]);
  useDeviceSyncStore.setState({ sources, legacySources: [], checkedIds: [], pendingDeletion: [] });
  return sources;
}

function rewritePlaylistStores(profileId: string): void {
  usePlaylistStore.setState(state => ({
    playlists: [...new Map(state.playlists.map(playlist => {
      const next = playlist.serverId === profileId ? {
          ...playlist,
          id: canonicalNavidromeId(playlist.id),
          coverArt: playlist.coverArt ? canonicalNavidromeArtworkId(playlist.coverArt) : undefined,
        } : playlist;
      return [`${next.serverId ?? ''}:${next.id}`, next] as const;
    })).values()],
    recentIds: [...new Set(state.recentIds.map(key => rewriteOwnedKey(key, profileId)))],
    lastModified: Object.entries(state.lastModified).reduce<Record<string, number>>((next, [key, value]) => {
      const rewritten = rewriteOwnedKey(key, profileId);
      next[rewritten] = Math.max(next[rewritten] ?? 0, value);
      return next;
    }, {}),
  }));
  usePlaylistFolderStore.setState(state => {
    const owned = state.byServer[profileId];
    if (!owned) return state;
    const assignments: Record<string, string> = {};
    for (const [playlistId, folderId] of Object.entries(owned.assignments)) {
      const rewritten = canonicalNavidromeId(playlistId);
      if (assignments[rewritten] && assignments[rewritten] !== folderId) {
        throw new Error(`Playlist folder collision at ${rewritten}`);
      }
      assignments[rewritten] = folderId;
    }
    return { byServer: { ...state.byServer, [profileId]: { ...owned, assignments } } };
  });
}

function rewriteLivePlayer(profileId: string, owners: ReadonlySet<string>, maps: EntityMaps): void {
  usePlayerStore.setState(state => ({
    currentTrack: state.currentTrack && (isOwnedBy(state.currentTrack.serverId, owners)
      || (!state.currentTrack.serverId && isOwnedBy(state.queueServerId, owners)))
      ? rewriteTrack(state.currentTrack, maps)
      : state.currentTrack,
    queueItems: state.queueItems.map(item => isOwnedBy(item.serverId, owners)
      ? { ...item, trackId: mapId(maps, 'track', item.trackId)! }
      : item),
    currentRadio: state.currentRadio?.serverId === profileId
      ? {
        ...state.currentRadio,
        id: canonicalNavidromeId(state.currentRadio.id),
        coverArt: state.currentRadio.coverArt
          ? canonicalNavidromeArtworkId(state.currentRadio.coverArt)
          : undefined,
      } satisfies InternetRadioStation
      : state.currentRadio,
  }));
}

async function rewriteKnownDeviceManifest(serverId: string, sources: DeviceSyncSource[], maps: EntityMaps): Promise<void> {
  const targetDir = useDeviceSyncStore.getState().targetDir;
  if (!targetDir) return;
  const manifest = await invoke<DeviceSyncManifest | null>('read_device_manifest', { destDir: targetDir });
  const manifestOwner = manifest?.ownerServerIndexKey
    ? resolveStorageServerIndexKey(manifest.ownerServerIndexKey)
    : null;
  if (manifestOwner && manifestOwner !== serverId) {
    throw new Error('Device Sync manifest belongs to another server');
  }
  const manifestSources = Array.isArray(manifest?.sources)
    ? manifest.sources.flatMap(source => {
      if (!source || typeof source !== 'object') return [];
      const candidate = source as Partial<DeviceSyncSource>;
      if ((candidate.type !== 'album' && candidate.type !== 'playlist' && candidate.type !== 'artist')
        || typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return [];
      const owned = { ...candidate, serverIndexKey: serverId } as DeviceSyncSource;
      return [rewriteDeviceSource(owned, serverId, maps)];
    })
    : [];
  const nextSources = dedupeDeviceSources([...sources, ...manifestSources]);
  if (!manifest && nextSources.length === 0) return;
  await invoke('write_device_manifest', {
    destDir: targetDir,
    ownerServerIndexKey: serverId,
    sources: nextSources,
  });
  const written = await invoke<DeviceSyncManifest | null>('read_device_manifest', { destDir: targetDir });
  if (written?.ownerServerIndexKey !== serverId || !Array.isArray(written.sources)) {
    throw new Error('Device Sync manifest verification failed');
  }
  assertCanonicalDeviceSources(written.sources, serverId);
}

function assertCanonicalId(value: string | undefined, label: string): void {
  if (value && canonicalNavidromeId(value) !== value) throw new Error(`Legacy ${label} remains in frontend persistence`);
}

function assertCanonicalArtwork(value: string | undefined): void {
  if (value && canonicalNavidromeArtworkId(value) !== value) throw new Error('Legacy artwork ID remains in frontend persistence');
}

function assertCanonicalTrack(track: Track | SubsonicSong): void {
  assertCanonicalId(track.id, 'track ID');
  assertCanonicalId(track.albumId, 'album ID');
  assertCanonicalId(track.artistId, 'artist ID');
  track.artists?.forEach(artist => assertCanonicalId(artist.id, 'artist ID'));
  assertCanonicalArtwork(track.coverArt);
}

function assertCanonicalDeviceSources(values: unknown[], serverId: string): void {
  for (const value of values) {
    const source = value as Partial<DeviceSyncSource>;
    if (source.serverIndexKey !== serverId) throw new Error('Device Sync source owner mismatch');
    assertCanonicalId(source.id, 'Device Sync source ID');
  }
}

function verifyFrontendState(profileId: string, serverId: string): void {
  const owners = new Set([profileId, serverId]);
  const auth = useAuthStore.getState();
  auth.musicFoldersByServer[profileId]?.forEach(folder => assertCanonicalId(folder.id, 'folder ID'));
  auth.libraryBrowseSelectionByServer[profileId]?.forEach(id => assertCanonicalId(id, 'folder ID'));
  auth.musicLibrarySelectionByServer[profileId]?.forEach(id => assertCanonicalId(id, 'folder ID'));
  const filter = auth.musicLibraryFilterByServer[profileId];
  if (filter && filter !== 'all') assertCanonicalId(filter, 'folder ID');
  for (const key of Object.keys(auth.skipStarManualSkipCountsByKey)) {
    const separator = key.indexOf('\u001f');
    if (key.slice(0, separator) === profileId) assertCanonicalId(key.slice(separator + 1), 'track ID');
  }
  Object.values(useLocalPlaybackStore.getState().entries).forEach(entry => {
    if (entry.serverIndexKey !== serverId) return;
    assertCanonicalId(entry.trackId, 'track ID');
    assertCanonicalId(entry.pinSource?.sourceId, 'pin source ID');
  });
  Object.values(useOfflineStore.getState().albums).forEach(meta => {
    if (meta.serverId !== serverId) return;
    assertCanonicalId(meta.id, 'offline source ID');
    meta.trackIds.forEach(id => assertCanonicalId(id, 'track ID'));
    assertCanonicalArtwork(meta.coverArt);
  });
  const device = useDeviceSyncStore.getState();
  assertCanonicalDeviceSources(device.sources, serverId);
  if (device.legacySources.length > 0) throw new Error('Ownerless Device Sync sources remain');
  usePlaylistStore.getState().playlists.forEach(playlist => {
    if (playlist.serverId !== profileId) return;
    assertCanonicalId(playlist.id, 'playlist ID');
    assertCanonicalArtwork(playlist.coverArt);
  });
  for (const id of Object.keys(usePlaylistFolderStore.getState().byServer[profileId]?.assignments ?? {})) {
    assertCanonicalId(id, 'playlist ID');
  }
  const player = usePlayerStore.getState();
  if (player.currentTrack && isOwnedBy(player.currentTrack.serverId, owners)) {
    assertCanonicalTrack(player.currentTrack);
  }
  player.queueItems.filter(item => isOwnedBy(item.serverId, owners))
    .forEach(item => assertCanonicalId(item.trackId, 'track ID'));

  const persistedPlayer = readJson(PLAYER_KEY) as { state?: Record<string, unknown> } | null;
  const persistedState = persistedPlayer?.state;
  const persistedCurrent = persistedState?.currentTrack as Track | null | undefined;
  if (persistedCurrent && (isOwnedBy(persistedCurrent.serverId, owners)
    || (!persistedCurrent.serverId && isOwnedBy(persistedState?.queueServerId as string | undefined, owners)))) {
    assertCanonicalTrack(persistedCurrent);
  }
  if (Array.isArray(persistedState?.queueItems)) {
    persistedState.queueItems.forEach(item => {
      const ref = item as { serverId?: string; trackId?: string };
      if (isOwnedBy(ref.serverId, owners)) assertCanonicalId(ref.trackId, 'track ID');
    });
  }

  const shuffle = readJson(SHUFFLE_KEY) as { originalOrder?: unknown[] } | null;
  shuffle?.originalOrder?.forEach(value => {
    if (typeof value !== 'string') return;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.length === 2 && isOwnedBy(parsed[0] as string, owners)) {
        assertCanonicalId(parsed[1] as string, 'shuffle track ID');
      }
    } catch {
      assertCanonicalId(value, 'shuffle track ID');
    }
  });

  for (const key of RADIO_KEYS) {
    const values = readJson(key);
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === 'string' && value.startsWith(`${profileId}:`)) {
        assertCanonicalId(value.slice(profileId.length + 1), 'radio ID');
      }
    }
  }

  const persistedPlaylists = readJson(PLAYLIST_KEY) as { state?: {
    playlists?: Array<{ id?: string; serverId?: string; coverArt?: string }>;
    recentIds?: string[];
    lastModified?: Record<string, number>;
  } } | null;
  for (const playlist of persistedPlaylists?.state?.playlists ?? []) {
    if (playlist.serverId !== profileId) continue;
    assertCanonicalId(playlist.id, 'playlist ID');
    assertCanonicalArtwork(playlist.coverArt);
  }
  for (const key of [
    ...(persistedPlaylists?.state?.recentIds ?? []),
    ...Object.keys(persistedPlaylists?.state?.lastModified ?? {}),
  ]) {
    if (key.startsWith(`${profileId}:`)) assertCanonicalId(key.slice(profileId.length + 1), 'playlist ID');
  }
}

function rewriteNewReleasesSeenState(profileId: string, maps: EntityMaps): void {
  const prefix = `${NEW_RELEASES_UNREAD_STORAGE_PREFIX}:`;
  const rewrites: Array<[string, string, string[]]> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    let fingerprint: unknown;
    try { fingerprint = JSON.parse(suffix); } catch { continue; }
    if (!Array.isArray(fingerprint)) continue;
    const nextFingerprint = fingerprint.map(entry => {
      if (!Array.isArray(entry) || entry[0] !== profileId || !Array.isArray(entry[1])) return entry;
      return [entry[0], entry[1].map(id => typeof id === 'string' ? mapId(maps, 'folder', id) : id)];
    });
    const ids = readJson(key);
    if (!Array.isArray(ids)) continue;
    rewrites.push([
      key,
      `${prefix}${JSON.stringify(nextFingerprint)}`,
      ids.flatMap(id => typeof id === 'string' ? [canonicalNavidromeId(id)] : []),
    ]);
  }
  for (const [oldKey, newKey, ids] of rewrites) {
    const existing = readJson(newKey);
    const merged = [...new Set([...(Array.isArray(existing) ? existing : []), ...ids])];
    localStorage.setItem(newKey, JSON.stringify(merged));
    if (oldKey !== newKey) localStorage.removeItem(oldKey);
  }
}

export async function rewriteNavidromeCanonicalFrontendState(
  migration: CanonicalMigrationDto,
): Promise<void> {
  const maps = buildMaps(migration.mappings);
  const serverId = migration.serverId;
  const matchingServer = useAuthStore.getState().servers.find(
    server => serverIndexKeyForProfile(server) === serverId,
  );
  if (!matchingServer) throw new Error(`No configured server owns migration scope ${serverId}`);
  const profileId = matchingServer.id;
  const owners = new Set([profileId, serverId]);

  rewriteRawPlayerState(owners, maps);
  rewriteShuffleState(serverId, maps);
  rewriteRadioState(profileId);
  rewriteAuthStore(profileId, maps);
  rewriteLocalPlaybackStore(serverId, maps);
  rewriteOfflineStore(serverId, maps);
  const deviceSources = rewriteDeviceSyncStore(serverId, maps);
  rewritePlaylistStores(profileId);
  rewriteNewReleasesSeenState(profileId, maps);
  rewriteLivePlayer(profileId, owners, maps);
  if (migration.state === 'ready') {
    await rewriteKnownDeviceManifest(serverId, deviceSources, maps).catch(() => {});
  } else {
    await rewriteKnownDeviceManifest(serverId, deviceSources, maps);
  }
  localStorage.removeItem('psysonic-hot-cache');
  localStorage.setItem('psysonic-local-playback-migrated-v1', '1');

  verifyFrontendState(profileId, serverId);
  if (!readJson(PLAYLIST_KEY)) throw new Error('Playlist persistence verification failed');
}
