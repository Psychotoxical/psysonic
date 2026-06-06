import type { LibraryTrackDto } from '../../api/library';
import { libraryGetTrack, libraryGetTracksBatchChunked } from '../../api/library';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { CoverServerScope } from '../../cover/types';
import { useAuthStore } from '../../store/authStore';
import type { LocalPlaybackEntry, PinnedGroup, PinSource } from '../../store/localPlaybackStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore, type OfflineAlbumMeta } from '../../store/offlineStore';
import { resolveTrackCoverArtId, trackToSong } from '../library/advancedSearchLocal';
import { canonicalQueueServerKey, resolveIndexKey } from '../server/serverIndexKey';
import type { Track } from '../../store/playerStoreTypes';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '../server/serverLookup';
import { serverIndexKeyForProfile } from '../server/serverIndexKey';

export interface OfflineLibraryCard {
  serverIndexKey: string;
  pinSource: PinSource;
  trackIds: string[];
  name: string;
  artist: string;
  coverArt?: string;
  /** 2×2 collage when the playlist has no single custom cover. */
  coverQuadIds?: (string | null)[];
  year?: number;
}

export function resolveOfflineAlbumMeta(
  albumId: string,
  serverId: string,
): OfflineAlbumMeta | undefined {
  const albums = useOfflineStore.getState().albums;
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  const indexKey = server ? serverIndexKeyForProfile(server) : serverId;
  return albums[`${indexKey}:${albumId}`] ?? albums[`${serverId}:${albumId}`];
}

function serverIndexKeysForServerId(serverId: string): string[] {
  const servers = useAuthStore.getState().servers;
  const server = servers.find(s => s.id === serverId);
  const keys = new Set<string>();
  if (server) {
    const profileKey = serverIndexKeyForProfile(server);
    if (profileKey) keys.add(profileKey);
    keys.add(server.id);
  }
  keys.add(resolveIndexKey(serverId));
  keys.add(serverId);
  return [...keys].filter(Boolean);
}

export function entryBelongsToServer(entry: LocalPlaybackEntry, serverId: string): boolean {
  return serverIndexKeysForServerId(serverId).includes(entry.serverIndexKey);
}

export function indexKeyBelongsToServer(serverIndexKey: string, serverId: string): boolean {
  return serverIndexKeysForServerId(serverId).includes(serverIndexKey);
}

/** Resolve a library-tier row across legacy UUID / URL index-key variants. */
export function findLocalPlaybackEntry(
  trackId: string,
  serverId: string,
): LocalPlaybackEntry | null {
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const hit = lp.getEntry(trackId, key);
    if (hit?.tier === 'library') return hit;
  }
  for (const entry of Object.values(lp.entries)) {
    if (entry.trackId !== trackId || entry.tier !== 'library') continue;
    if (entryBelongsToServer(entry, serverId)) return entry;
  }
  return null;
}

/** Index cache; run {@link reconcileLibraryTierForAlbum} / server reconcile so rows match disk. */
export function hasLocalLibraryBytes(trackId: string, serverId: string): boolean {
  return !!findLocalPlaybackEntry(trackId, serverId)?.localPath;
}

/** Resolve a `favorite-auto` tier row across index-key variants. */
export function findFavoriteAutoEntry(
  trackId: string,
  serverId: string,
): LocalPlaybackEntry | null {
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const hit = lp.getEntry(trackId, key);
    if (hit?.tier === 'favorite-auto') return hit;
  }
  for (const entry of Object.values(lp.entries)) {
    if (entry.trackId !== trackId || entry.tier !== 'favorite-auto') continue;
    if (entryBelongsToServer(entry, serverId)) return entry;
  }
  return null;
}

export function hasLocalFavoriteAutoBytes(trackId: string, serverId: string): boolean {
  return !!findFavoriteAutoEntry(trackId, serverId)?.localPath;
}

/** Manual offline library or favorites auto-sync — skip redundant hot-cache prefetch/promote. */
export function hasLocalPersistentPlaybackBytes(trackId: string, serverId: string): boolean {
  return hasLocalLibraryBytes(trackId, serverId) || hasLocalFavoriteAutoBytes(trackId, serverId);
}

/** Resolve `psysonic-local://` across legacy UUID / host index-key variants. */
export function findLocalPlaybackUrl(
  trackId: string,
  serverId: string,
  tier: 'library' | 'ephemeral' | 'favorite-auto',
): string | null {
  if (tier === 'library') {
    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (entry?.localPath) return `psysonic-local://${entry.localPath}`;
    return null;
  }
  if (tier === 'favorite-auto') {
    const entry = findFavoriteAutoEntry(trackId, serverId);
    if (entry?.localPath) return `psysonic-local://${entry.localPath}`;
    return null;
  }
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const url = lp.getLocalUrl(trackId, key, 'ephemeral');
    if (url) return url;
  }
  return null;
}

/** Songs that still need a library-tier pin (used to skip redundant downloads). */
export function pendingOfflinePinSongs<T extends { id: string }>(
  songs: T[],
  serverId: string,
): T[] {
  return songs.filter(s => !hasLocalLibraryBytes(s.id, serverId));
}

/** True when every track in the offline pin group has local library-tier bytes. */
export function isOfflinePinComplete(
  albumId: string,
  serverId: string,
  songIds?: string[],
): boolean {
  if (songIds?.length) {
    return songIds.every(tid => hasLocalLibraryBytes(tid, serverId));
  }
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  const indexKey = server ? (serverIndexKeyForProfile(server) || serverId) : serverId;
  const meta = resolveOfflineAlbumMeta(albumId, serverId);
  const groupTrackIds = useLocalPlaybackStore.getState()
    .listPinnedGroups(indexKey)
    .find(g => g.pinSource.sourceId === albumId)?.trackIds;
  const trackIds = meta?.trackIds.length
    ? meta.trackIds
    : (groupTrackIds ?? []);
  if (trackIds.length === 0) return false;
  return trackIds.every(tid => hasLocalLibraryBytes(tid, serverId));
}

/** @deprecated Use {@link reconcileLibraryTierForAlbum} from `./libraryTierReconcile`. */
export async function syncAlbumLibraryTierFromDisk(
  albumId: string,
  serverId: string,
  songs: SubsonicSong[],
  pinSource?: PinSource,
): Promise<number> {
  const { reconcileLibraryTierForAlbum } = await import('./libraryTierReconcile');
  const result = await reconcileLibraryTierForAlbum(serverId, songs, pinSource ?? {
    kind: 'album',
    sourceId: albumId,
  });
  return result.syncedFromDisk;
}

/** @deprecated Use {@link listOfflineLibraryCards}. */
export function hasAnyOfflineAlbums(albums: Record<string, OfflineAlbumMeta>): boolean {
  if (Object.keys(albums).length > 0) return true;
  return useLocalPlaybackStore.getState().listPinnedGroups().length > 0;
}

export function libraryDtoToTrack(dto: LibraryTrackDto): Track {
  const song = trackToSong(dto);
  return {
    id: song.id,
    title: song.title,
    artist: song.artist ?? '',
    album: song.album,
    albumId: song.albumId ?? '',
    artistId: song.artistId,
    duration: song.duration ?? 0,
    coverArt: song.coverArt,
    discNumber: song.discNumber,
    track: song.track,
    year: song.year,
    bitRate: song.bitRate,
    suffix: song.suffix,
    genre: song.genre,
    replayGainTrackDb: dto.replayGainTrackDb ?? undefined,
    replayGainAlbumDb: dto.replayGainAlbumDb ?? undefined,
    size: song.size,
    serverId: dto.serverId,
  };
}

function legacyCoverForPinnedGroup(group: PinnedGroup): string | undefined {
  const albums: OfflineAlbumMeta[] = [...Object.values(useOfflineStore.getState().albums)];
  try {
    const raw = localStorage.getItem('psysonic-offline');
    if (raw) {
      const blob = JSON.parse(raw) as { state?: { albums?: Record<string, OfflineAlbumMeta> } };
      albums.push(...Object.values(blob.state?.albums ?? {}));
    }
  } catch { /* ignore */ }

  const pinKind = group.pinSource.kind ?? 'album';
  for (const album of albums) {
    if (album.id !== group.pinSource.sourceId) continue;
    if (album.type && album.type !== pinKind) continue;
    const albumKey = resolveIndexKey(album.serverId);
    if (albumKey !== group.serverIndexKey && album.serverId !== group.serverIndexKey) continue;
    const cover = album.coverArt?.trim();
    if (cover) return cover;
  }
  return undefined;
}

function buildPlaylistCoverQuad(
  trackIds: string[],
  byId: Map<string, LibraryTrackDto>,
  libraryServerId: string,
): (string | null)[] {
  const seen = new Set<string>();
  const covers: string[] = [];
  for (const trackId of trackIds) {
    const dto = byId.get(`${libraryServerId}:${trackId}`);
    if (!dto) continue;
    const cover = resolveTrackCoverArtId(dto);
    if (!cover || seen.has(cover)) continue;
    seen.add(cover);
    covers.push(cover);
    if (covers.length >= 4) break;
  }
  if (covers.length === 0) return [];
  return Array.from({ length: 4 }, (_, i) => covers[i % covers.length] ?? null);
}

export async function hydrateOfflineLibraryCards(
  groups: PinnedGroup[],
): Promise<OfflineLibraryCard[]> {
  if (groups.length === 0) return [];
  const refs = groups.flatMap(g =>
    g.trackIds.map(trackId => ({
      serverId: resolveServerIdForIndexKey(g.serverIndexKey) || g.serverIndexKey,
      trackId,
    })),
  );
  const tracks = await libraryGetTracksBatchChunked(refs);
  const byId = new Map(tracks.map(t => [`${t.serverId}:${t.id}`, t]));

  return groups.map(group => {
    const libraryServerId = resolveServerIdForIndexKey(group.serverIndexKey) || group.serverIndexKey;
    const first = group.trackIds
      .map(tid => byId.get(`${libraryServerId}:${tid}`))
      .find(Boolean);
    const pinKind = group.pinSource.kind ?? 'album';
    const pinnedMeta = resolveOfflineAlbumMeta(group.pinSource.sourceId, libraryServerId);
    const legacyCover = legacyCoverForPinnedGroup(group);
    const displayName = pinKind === 'album'
      ? (group.pinSource.displayName
        ?? first?.album
        ?? first?.title
        ?? group.pinSource.sourceId)
      : (group.pinSource.displayName ?? group.pinSource.sourceId);
    const artist = pinKind === 'artist'
      ? (group.pinSource.displayName ?? first?.artist ?? '')
      : pinKind === 'playlist'
        ? ''
        : (first?.artist ?? first?.albumArtist ?? '');

    let coverArt: string | undefined;
    let coverQuadIds: (string | null)[] | undefined;
    if (pinKind === 'playlist') {
      coverArt = pinnedMeta?.coverArt?.trim() || legacyCover || undefined;
      if (!coverArt) {
        const quad = buildPlaylistCoverQuad(group.trackIds, byId, libraryServerId);
        if (quad.some(Boolean)) coverQuadIds = quad;
      }
    } else {
      coverArt = pinnedMeta?.coverArt?.trim()
        || legacyCover
        || (first ? resolveTrackCoverArtId(first) : undefined);
    }

    return {
      serverIndexKey: group.serverIndexKey,
      pinSource: group.pinSource,
      trackIds: group.trackIds,
      name: displayName,
      artist,
      coverArt,
      coverQuadIds,
      year: pinKind === 'album' ? (first?.year ?? undefined) : undefined,
    };
  });
}

function fallbackTrackFromLocalEntry(
  trackId: string,
  serverId: string,
  card: OfflineLibraryCard,
): Track | null {
  const entry = findLocalPlaybackEntry(trackId, serverId);
  if (!entry?.localPath) return null;
  return {
    id: trackId,
    title: card.pinSource.displayName ?? card.name,
    artist: card.artist,
    album: card.name,
    albumId: card.pinSource.kind === 'album' ? card.pinSource.sourceId : '',
    duration: 0,
    coverArt: card.coverArt,
    suffix: entry.suffix ?? 'mp3',
    size: entry.sizeBytes,
  };
}

export async function ensureServerForOfflineIndexKey(serverIndexKey: string): Promise<boolean> {
  const { activeServerId, servers } = useAuthStore.getState();
  const resolved = resolveServerIdForIndexKey(serverIndexKey) || serverIndexKey;
  if (resolved === activeServerId) return true;
  const server = servers.find(s => s.id === resolved)
    ?? findServerByIdOrIndexKey(serverIndexKey);
  if (!server) return false;
  const auth = useAuthStore.getState();
  auth.setActiveServer(server.id);
  auth.setLoggedIn(true);
  return true;
}

function listEphemeralCacheEntries(): LocalPlaybackEntry[] {
  return Object.values(useLocalPlaybackStore.getState().entries)
    .filter(e => e.tier === 'ephemeral' && e.localPath)
    .sort((a, b) => (b.lastPlayedAt ?? b.cachedAt) - (a.lastPlayedAt ?? a.cachedAt));
}

/** Indexed ephemeral rows with on-disk bytes under `{media}/cache/`. */
export function countEphemeralCacheTracks(): number {
  return listEphemeralCacheEntries().length;
}

export function ephemeralCacheCoverScope(): CoverServerScope | null {
  const entry = listEphemeralCacheEntries()[0];
  if (!entry) return null;
  const server = findServerByIdOrIndexKey(entry.serverIndexKey);
  if (!server) return null;
  return {
    kind: 'server',
    serverId: server.id,
    url: server.url,
    username: server.username,
    password: server.password,
  };
}

/** Up to four cover IDs for a playlist-style collage from hot-cache tracks. */
export async function collectEphemeralCacheCoverQuad(): Promise<(string | null)[]> {
  const ephemeral = listEphemeralCacheEntries();
  if (ephemeral.length === 0) return [null, null, null, null];
  const refs = ephemeral.slice(0, 16).map(e => ({
    serverId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
    trackId: e.trackId,
  }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const covers: string[] = [];
  for (const dto of dtos) {
    const cover = resolveTrackCoverArtId(dto);
    if (cover && !covers.includes(cover)) covers.push(cover);
    if (covers.length >= 4) break;
  }
  return Array.from({ length: 4 }, (_, i) => covers[i] ?? null);
}

function listFavoriteAutoEntries(): LocalPlaybackEntry[] {
  return Object.values(useLocalPlaybackStore.getState().entries)
    .filter(e => e.tier === 'favorite-auto' && e.localPath)
    .sort((a, b) => (b.lastPlayedAt ?? b.cachedAt) - (a.lastPlayedAt ?? a.cachedAt));
}

/** Indexed favorite-auto rows with on-disk bytes under `{media}/favorites/`. */
export function countFavoriteAutoTracks(): number {
  return listFavoriteAutoEntries().length;
}

export function favoriteAutoCoverScope(): CoverServerScope | null {
  const entry = listFavoriteAutoEntries()[0];
  if (!entry) return null;
  const server = findServerByIdOrIndexKey(entry.serverIndexKey);
  if (!server) return null;
  return {
    kind: 'server',
    serverId: server.id,
    url: server.url,
    username: server.username,
    password: server.password,
  };
}

export type OfflineCoverQuadCell = {
  coverArtId: string;
  serverId: string;
} | null;

/** Up to four cover cells for a collage from favorites-tier tracks (per-server scope). */
export async function collectFavoriteAutoCoverQuad(): Promise<OfflineCoverQuadCell[]> {
  const favorites = listFavoriteAutoEntries();
  if (favorites.length === 0) return [null, null, null, null];
  const refs = favorites.slice(0, 16).map(e => ({
    serverId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
    trackId: e.trackId,
  }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const cells: { coverArtId: string; serverId: string }[] = [];
  const seen = new Set<string>();
  for (const dto of dtos) {
    const coverArtId = resolveTrackCoverArtId(dto);
    if (!coverArtId) continue;
    const dedupeKey = `${dto.serverId}:${coverArtId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    cells.push({ coverArtId, serverId: dto.serverId });
    if (cells.length >= 4) break;
  }
  return Array.from({ length: 4 }, (_, i) => cells[i] ?? null);
}

/** Playable tracks under `{media}/favorites/` only (favorite-auto tier). */
export async function buildOfflineFavoritesQueueTracks(): Promise<{
  tracks: Track[];
  queueServerIndexKey: string | null;
}> {
  const favorites = listFavoriteAutoEntries();
  if (favorites.length === 0) {
    return { tracks: [], queueServerIndexKey: null };
  }

  const refs = favorites.map(e => ({
    serverId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
    trackId: e.trackId,
  }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const dtoById = new Map(dtos.map(d => [`${d.serverId}:${d.id}`, d]));

  const tracks: Track[] = [];
  let queueServerIndexKey: string | null = null;
  for (const entry of favorites) {
    const serverId = resolveServerIdForIndexKey(entry.serverIndexKey) || entry.serverIndexKey;
    const dto = dtoById.get(`${serverId}:${entry.trackId}`);
    if (dto) {
      tracks.push(libraryDtoToTrack(dto));
    } else {
      tracks.push({
        id: entry.trackId,
        title: entry.trackId,
        artist: '',
        album: '',
        albumId: '',
        duration: 0,
        suffix: entry.suffix,
        size: entry.sizeBytes,
        serverId,
      });
    }
    queueServerIndexKey ??= entry.serverIndexKey;
  }

  return { tracks, queueServerIndexKey };
}

/** Playable tracks under `{media}/cache/` only (ephemeral / hot-cache tier). */
export async function buildOfflineCacheQueueTracks(): Promise<{
  tracks: Track[];
  queueServerIndexKey: string | null;
}> {
  const ephemeral = listEphemeralCacheEntries();
  if (ephemeral.length === 0) {
    return { tracks: [], queueServerIndexKey: null };
  }

  const refs = ephemeral.map(e => ({
    serverId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
    trackId: e.trackId,
  }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const dtoById = new Map(dtos.map(d => [`${d.serverId}:${d.id}`, d]));

  const tracks: Track[] = [];
  let queueServerIndexKey: string | null = null;
  for (const entry of ephemeral) {
    const serverId = resolveServerIdForIndexKey(entry.serverIndexKey) || entry.serverIndexKey;
    const dto = dtoById.get(`${serverId}:${entry.trackId}`);
    if (dto) {
      tracks.push(libraryDtoToTrack(dto));
    } else {
      tracks.push({
        id: entry.trackId,
        title: entry.trackId,
        artist: '',
        album: '',
        albumId: '',
        duration: 0,
        suffix: entry.suffix,
        size: entry.sizeBytes,
        serverId,
      });
    }
    queueServerIndexKey ??= entry.serverIndexKey;
  }

  return { tracks, queueServerIndexKey };
}

export async function buildTracksForOfflineCard(card: OfflineLibraryCard): Promise<Track[]> {
  const serverId = resolveServerIdForIndexKey(card.serverIndexKey) || card.serverIndexKey;
  const localTrackIds = card.trackIds.filter(tid => hasLocalLibraryBytes(tid, serverId));
  if (localTrackIds.length === 0) return [];

  const refs = localTrackIds.map(trackId => ({ serverId, trackId }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const dtoById = new Map(dtos.map(d => [d.id, d]));
  const order = new Map(localTrackIds.map((id, i) => [id, i]));
  const tracks: Track[] = [];

  for (const trackId of localTrackIds) {
    const dto = dtoById.get(trackId);
    if (dto) {
      tracks.push(libraryDtoToTrack(dto));
      continue;
    }
    const single = await libraryGetTrack(serverId, trackId).catch(() => null);
    if (single) {
      tracks.push(libraryDtoToTrack(single));
      continue;
    }
    const fallback = fallbackTrackFromLocalEntry(trackId, serverId, card);
    if (fallback) tracks.push(fallback);
  }

  return tracks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** @deprecated */
export function buildOfflineTracksForAlbum(
  album: OfflineAlbumMeta,
  tracks: Record<string, never>,
): Track[] {
  void tracks;
  return [];
}

export function offlineAlbumCoverScope(card: Pick<OfflineLibraryCard, 'serverIndexKey' | 'coverArt'>): CoverServerScope | null {
  if (!card.coverArt) return null;
  const server = findServerByIdOrIndexKey(card.serverIndexKey);
  if (!server) return null;
  return {
    kind: 'server',
    serverId: server.id,
    url: server.url,
    username: server.username,
    password: server.password,
  };
}

/** Offline play only needs the library index + on-disk bytes — no live server ping. */
export async function ensureServerForOfflineCard(card: OfflineLibraryCard): Promise<boolean> {
  return ensureServerForOfflineIndexKey(card.serverIndexKey);
}

export function offlineQueueServerKeyForCard(card: OfflineLibraryCard): string {
  return canonicalQueueServerKey(card.serverIndexKey);
}

export function offlineTrackCount(card: OfflineLibraryCard): number {
  const serverId = resolveServerIdForIndexKey(card.serverIndexKey) || card.serverIndexKey;
  return card.trackIds.filter(tid => hasLocalLibraryBytes(tid, serverId)).length;
}

export function offlineLibraryCardKey(card: OfflineLibraryCard): string {
  return `${card.serverIndexKey}:${card.pinSource.kind}:${card.pinSource.sourceId}`;
}
