import type { LibraryTrackDto } from '../../api/library';
import { libraryGetTracksBatch } from '../../api/library';
import type { CoverServerScope } from '../../cover/types';
import { useAuthStore } from '../../store/authStore';
import type { PinnedGroup, PinSource } from '../../store/localPlaybackStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore, type OfflineAlbumMeta } from '../../store/offlineStore';
import { resolveTrackCoverArtId } from '../library/advancedSearchLocal';
import { resolveIndexKey } from '../server/serverIndexKey';
import { switchActiveServer } from '../server/switchActiveServer';
import type { Track } from '../../store/playerStoreTypes';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '../server/serverLookup';

export interface OfflineLibraryCard {
  serverIndexKey: string;
  pinSource: PinSource;
  trackIds: string[];
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
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

  for (const album of albums) {
    if (album.id !== group.pinSource.sourceId) continue;
    const albumKey = resolveIndexKey(album.serverId);
    if (albumKey !== group.serverIndexKey && album.serverId !== group.serverIndexKey) continue;
    const cover = album.coverArt?.trim();
    if (cover) return cover;
  }
  return undefined;
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
  const tracks = await libraryGetTracksBatch(refs);
  const byId = new Map(tracks.map(t => [`${t.serverId}:${t.id}`, t]));

  return groups.map(group => {
    const libraryServerId = resolveServerIdForIndexKey(group.serverIndexKey) || group.serverIndexKey;
    const first = group.trackIds
      .map(tid => byId.get(`${libraryServerId}:${tid}`))
      .find(Boolean);
    const displayName = group.pinSource.displayName
      ?? first?.album
      ?? first?.title
      ?? group.pinSource.sourceId;
    const artist = group.pinSource.kind === 'artist'
      ? (group.pinSource.displayName ?? first?.artist ?? '')
      : (first?.artist ?? first?.albumArtist ?? '');
    const coverArt = (first ? resolveTrackCoverArtId(first) : undefined)
      ?? legacyCoverForPinnedGroup(group);
    return {
      serverIndexKey: group.serverIndexKey,
      pinSource: group.pinSource,
      trackIds: group.trackIds,
      name: displayName,
      artist,
      coverArt,
      year: first?.year ?? undefined,
    };
  });
}

export async function buildTracksForOfflineCard(card: OfflineLibraryCard): Promise<Track[]> {
  const serverId = resolveServerIdForIndexKey(card.serverIndexKey) || card.serverIndexKey;
  const refs = card.trackIds.map(trackId => ({ serverId, trackId }));
  const dtos = await libraryGetTracksBatch(refs);
  const order = new Map(card.trackIds.map((id, i) => [id, i]));
  return dtos
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map(libraryDtoToTrack);
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

export async function ensureServerForOfflineCard(card: OfflineLibraryCard): Promise<boolean> {
  const { activeServerId, servers } = useAuthStore.getState();
  const resolved = resolveServerIdForIndexKey(card.serverIndexKey);
  if (resolved === activeServerId) return true;
  const server = servers.find(s => s.id === resolved)
    ?? findServerByIdOrIndexKey(card.serverIndexKey);
  if (!server) return false;
  return switchActiveServer(server);
}

export function offlineTrackCount(card: OfflineLibraryCard): number {
  return card.trackIds.filter(tid =>
    useLocalPlaybackStore.getState().isPinned(tid, card.serverIndexKey),
  ).length;
}
