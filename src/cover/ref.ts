import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { findServerByIdOrIndexKey } from '../utils/server/serverLookup';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { CoverArtId, CoverArtRef, CoverCacheKind, CoverServerScope } from './types';
import { resolveSubsonicSongCoverArtId } from './resolveCoverArtId';

/**
 * Logical cache identity for the UI — must match Rust `psysonic_core::cover_cache_layout`
 * inputs (`cache_kind` + `cache_entity_id`). On-disk path shape is owned only in Rust.
 */

export type AlbumCoverRefOptions = {
  serverScope?: CoverServerScope;
  /** Per-disc disk dirs — only for multi-CD albums with different art (see {@link albumHasDistinctDiscCovers}). */
  distinctDiscCovers?: boolean;
};

const albumDistinctDiscCoversByAlbumId = new Map<string, boolean>();

/** Remember result of {@link albumHasDistinctDiscCovers} while an album page is open (playback). */
export function rememberAlbumDistinctDiscCovers(albumId: string, songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber' | 'coverArt' | 'id' | 'albumId'>>): void {
  const id = albumId.trim();
  if (!id) return;
  albumDistinctDiscCoversByAlbumId.set(id, albumHasDistinctDiscCovers(songs));
}

export function forgetAlbumDistinctDiscCovers(albumId: string): void {
  albumDistinctDiscCoversByAlbumId.delete(albumId.trim());
}

function resolveAlbumCoverRefOptions(
  third?: CoverServerScope | AlbumCoverRefOptions,
): { serverScope: CoverServerScope; distinctDiscCovers: boolean } {
  if (!third || 'kind' in third) {
    return { serverScope: third ?? { kind: 'active' }, distinctDiscCovers: false };
  }
  return {
    serverScope: third.serverScope ?? { kind: 'active' },
    distinctDiscCovers: third.distinctDiscCovers ?? false,
  };
}

/** True when the album has 2+ discs and at least two discs use different cover art ids. */
export function albumHasDistinctDiscCovers(
  songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber' | 'coverArt' | 'id' | 'albumId'>>,
): boolean {
  const artByDisc = new Map<number, string>();
  for (const song of songs) {
    const disc = song.discNumber ?? 1;
    const artId = resolveSubsonicSongCoverArtId(song);
    if (!artId) continue;
    const prev = artByDisc.get(disc);
    if (prev !== undefined && prev !== artId) return true;
    artByDisc.set(disc, artId);
  }
  if (artByDisc.size <= 1) return false;
  return new Set(artByDisc.values()).size > 1;
}

/**
 * Disk cache entity for album-scoped art. Default: `albumId` only (one folder per album).
 * Use `distinctDiscCovers` when {@link albumHasDistinctDiscCovers} is true.
 */
export function resolveAlbumCoverCacheEntityId(
  albumId: string,
  fetchCoverArtId?: string | null,
  distinctDiscCovers = false,
): string {
  const album = albumId.trim();
  const fetch = (fetchCoverArtId ?? album).trim();
  if (!album) return fetch;
  if (!fetch || fetch === album) return album;
  if (distinctDiscCovers) return fetch;
  return album;
}

export function albumCoverRef(
  albumId: string,
  fetchCoverArtId?: string | null,
  scopeOrOpts: CoverServerScope | AlbumCoverRefOptions = { kind: 'active' },
): CoverArtRef {
  const { serverScope, distinctDiscCovers } = resolveAlbumCoverRefOptions(scopeOrOpts);
  const fetch = (fetchCoverArtId ?? albumId).trim();
  return {
    cacheKind: 'album',
    cacheEntityId: resolveAlbumCoverCacheEntityId(albumId, fetchCoverArtId, distinctDiscCovers),
    fetchCoverArtId: fetch,
    serverScope,
  };
}

/** Song row / search — album bucket unless caller passes `distinctDiscCovers`. */
export function albumCoverRefForSong(
  song: Pick<SubsonicSong, 'albumId' | 'coverArt' | 'id' | 'discNumber'>,
  distinctDiscCovers = false,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | undefined {
  const albumId = song.albumId?.trim();
  if (!albumId) return undefined;
  return albumCoverRef(albumId, song.coverArt, { serverScope, distinctDiscCovers });
}

/** Player / queue — uses album-page memory when available; else CD≥2 + distinct cover id. */
export function albumCoverRefForPlayback(
  track: Pick<SubsonicSong, 'coverArt' | 'id' | 'discNumber'> & { albumId?: string | null },
  serverScope: CoverServerScope = resolvePlaybackCoverScope(),
): CoverArtRef | undefined {
  const albumId = track.albumId?.trim();
  if (!albumId) return undefined;
  const known = albumDistinctDiscCoversByAlbumId.get(albumId);
  const cover = track.coverArt?.trim();
  const fallbackDisc =
    (track.discNumber ?? 1) > 1 && Boolean(cover && cover !== albumId);
  const distinctDiscCovers = known === true || (known === undefined && fallbackDisc);
  return albumCoverRef(albumId, track.coverArt, { serverScope, distinctDiscCovers });
}

export function artistCoverRef(
  artistId: string,
  fetchCoverArtId?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  const entityId = artistId.trim();
  const fetch = (fetchCoverArtId ?? artistId).trim();
  return {
    cacheKind: 'artist',
    cacheEntityId: entityId,
    fetchCoverArtId: fetch,
    serverScope,
  };
}

/** Build a cover ref from grid/row props (album by default). */
export function coverRefFromEntity(
  cacheKind: CoverCacheKind,
  cacheEntityId: string,
  fetchCoverArtId?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  return cacheKind === 'artist'
    ? artistCoverRef(cacheEntityId, fetchCoverArtId, serverScope)
    : albumCoverRef(cacheEntityId, fetchCoverArtId, serverScope);
}

/** @deprecated Prefer {@link albumCoverRef} / {@link artistCoverRef}. */
export function coverArtRef(
  coverArtId: CoverArtId,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  const id = coverArtId.trim();
  if (id.startsWith('ar-')) return artistCoverRef(id, id, serverScope);
  return albumCoverRef(id, id, serverScope);
}

export function resolvePlaybackCoverScope(): CoverServerScope {
  const playbackSid = getPlaybackServerId();
  const activeSid = useAuthStore.getState().activeServerId;
  if (playbackSid && activeSid && playbackSid !== activeSid) {
    const server = findServerByIdOrIndexKey(playbackSid);
    if (server) {
      return {
        kind: 'server',
        serverId: server.id,
        url: server.url,
        username: server.username,
        password: server.password,
      };
    }
  }
  return { kind: 'playback' };
}
