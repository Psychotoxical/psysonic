import { getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { coverServerScopeForOwnerServerId, coverServerScopeForServerId } from './serverScope';
import type { InternetRadioStation, SubsonicSong } from '@/lib/api/subsonicTypes';
import { coverArtIdFromRadio } from './ids';
import type { CoverArtId, CoverArtRef, CoverCacheKind, CoverServerScope } from './types';
import {
  albumHasDistinctDiscCovers,
  coverEntryToRef,
  resolveAlbumCoverEntry,
  resolveArtistCoverEntry,
  resolveTrackCoverEntry,
} from './resolveEntry';

export type { CoverEntry } from './resolveEntry';
export { albumHasDistinctDiscCovers } from './resolveEntry';

export type AlbumCoverRefOptions = {
  serverScope?: CoverServerScope;
  distinctDiscCovers?: boolean;
};

const albumDistinctDiscCoversByAlbumId = new Map<string, boolean>();
const albumDiscCountByAlbumId = new Map<string, number>();

function distinctDiscCoverKey(albumId: string, serverId?: string | null): string {
  const id = albumId.trim();
  const owner = serverId?.trim();
  return owner ? `${owner}\u0000${id}` : id;
}

function discCountFromSongs(
  songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber'>>,
): number {
  const discs = new Set<number>();
  for (const song of songs) {
    const disc = song.discNumber;
    discs.add(typeof disc === 'number' && Number.isFinite(disc) ? disc : 1);
  }
  return discs.size;
}

export function rememberAlbumDistinctDiscCovers(
  albumId: string,
  songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber' | 'coverArt' | 'id' | 'albumId'>>,
  serverId?: string | null,
): void {
  const id = albumId.trim();
  if (!id) return;
  const key = distinctDiscCoverKey(id, serverId);
  albumDistinctDiscCoversByAlbumId.set(key, albumHasDistinctDiscCovers(songs));
  albumDiscCountByAlbumId.set(key, discCountFromSongs(songs));
}

export function forgetAlbumDistinctDiscCovers(albumId: string, serverId?: string | null): void {
  const key = distinctDiscCoverKey(albumId, serverId);
  albumDistinctDiscCoversByAlbumId.delete(key);
  albumDiscCountByAlbumId.delete(key);
}

/**
 * Record the number of distinct discs an album spans, so per-disc cover
 * resolution can be gated on genuine multi-disc releases without an async index
 * query. Seeded from a known tracklist (album detail) or the local-index
 * `library_album_disc_count` command (queue / playbar for a track opened from a
 * playlist). `discCount <= 1` marks a single-disc album — the shared album slot.
 */
export function rememberAlbumDiscCount(
  albumId: string,
  discCount: number,
  serverId?: string | null,
): void {
  const id = albumId.trim();
  if (!id || !Number.isFinite(discCount)) return;
  albumDiscCountByAlbumId.set(distinctDiscCoverKey(id, serverId), Math.max(0, Math.trunc(discCount)));
}

/** Known distinct-disc count for an album, or `undefined` when not yet seeded. */
export function resolveAlbumDiscCount(
  albumId: string,
  serverId?: string | null,
): number | undefined {
  return albumDiscCountByAlbumId.get(distinctDiscCoverKey(albumId, serverId));
}

/**
 * Synchronous answer for "does this album use genuine per-disc artwork?", used
 * for the initial cover ref before the library index resolves.
 *
 * Per-disc artwork can only be determined from the full tracklist (see
 * {@link albumHasDistinctDiscCovers}). A single track's `mf-<id>` cover or disc
 * number is no signal: Navidrome (and other OpenSubsonic servers) give every
 * track its own `mf-<id>` coverArt, so guessing per-disc from one track marked
 * ordinary per-song albums as distinct and routed playback to a per-track cache
 * slot — surfacing per-track art in Now Playing / the queue when a song was
 * played from a playlist (the album page seeds the truth, so it looked correct
 * there). Trust only the value remembered from a known tracklist; default to
 * album-scoped and let the library index correct genuine per-disc albums.
 */
export function resolveDistinctDiscCoversForAlbum(
  albumId: string,
  serverId?: string | null,
): boolean {
  return albumDistinctDiscCoversByAlbumId.get(distinctDiscCoverKey(albumId, serverId)) === true;
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

/** @deprecated Use {@link resolveAlbumCoverEntry}. */
export function resolveAlbumCoverCacheEntityId(
  albumId: string,
  fetchCoverArtId?: string | null,
  distinctDiscCovers = false,
): string {
  return resolveAlbumCoverEntry(albumId, fetchCoverArtId, distinctDiscCovers)?.cacheEntityId ?? '';
}

/**
 * Sync fallback for cover identity — UI should prefer {@link useAlbumCoverRef} /
 * {@link AlbumCoverArtImage}; async paths should use {@link resolveAlbumCoverRefFromLibrary}.
 */
export function albumCoverRef(
  albumId: string,
  fetchCoverArtId?: string | null,
  scopeOrOpts: CoverServerScope | AlbumCoverRefOptions = { kind: 'active' },
): CoverArtRef {
  const { serverScope, distinctDiscCovers } = resolveAlbumCoverRefOptions(scopeOrOpts);
  const entry = resolveAlbumCoverEntry(albumId, fetchCoverArtId, distinctDiscCovers);
  if (!entry) {
    const id = (fetchCoverArtId ?? albumId).trim();
    return coverEntryToRef(
      { cacheKind: 'album', cacheEntityId: id, fetchCoverArtId: id },
      serverScope,
    );
  }
  return coverEntryToRef(entry, serverScope);
}

export function radioCoverRef(
  station: Pick<InternetRadioStation, 'id' | 'serverId'>,
): CoverArtRef {
  const coverArtId = coverArtIdFromRadio(station.id);
  const serverScope = station.serverId
    ? coverServerScopeForOwnerServerId(station.serverId)
    : { kind: 'active' as const };
  return albumCoverRef(coverArtId, coverArtId, serverScope);
}

export function albumCoverRefForSong(
  song: Pick<SubsonicSong, 'albumId' | 'coverArt' | 'id' | 'discNumber' | 'serverId'>,
  distinctDiscCovers?: boolean,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | undefined {
  const albumId = song.albumId?.trim();
  const distinct =
    distinctDiscCovers
    ?? (albumId ? resolveDistinctDiscCoversForAlbum(albumId, song.serverId) : false);
  const entry = resolveTrackCoverEntry(song, distinct);
  return entry ? coverEntryToRef(entry, serverScope) : undefined;
}

/**
 * Navidrome disc-artwork ref (`dc-<albumId>:<discNumber>`) — the server's own canonical
 * per-disc cover. Navidrome resolves it to the disc's embedded / external art and falls
 * back to the album cover when a disc has no distinct image, so it is always safe there.
 *
 * Built from `albumId` + `discNumber` alone (no per-track cover id needed), so it also
 * works when songs come from the local index (which may carry no `coverArt`). The `dc-`
 * prefix is Navidrome-specific — callers MUST gate on the server type (see
 * {@link useDiscCoverRef}) and fall back for non-Navidrome servers.
 *
 * The disk slot is per disc (`dc-<albumId>:<n>`, colon sanitized to `_` on disk), so
 * there is exactly one cache entry per disc — no per-song explosion.
 */
export function navidromeDiscCoverRef(
  albumId: string,
  discNumber: number,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | undefined {
  const al = albumId.trim();
  if (!al || !Number.isFinite(discNumber)) return undefined;
  const id = `dc-${al}:${discNumber}`;
  return coverEntryToRef(
    { cacheKind: 'album', cacheEntityId: id, fetchCoverArtId: id },
    serverScope,
  );
}

export function albumCoverRefForPlayback(
  track: Pick<SubsonicSong, 'coverArt' | 'id' | 'discNumber' | 'serverId'> & { albumId?: string | null },
  serverScope: CoverServerScope = resolvePlaybackCoverScope(),
): CoverArtRef | undefined {
  const albumId = track.albumId?.trim();
  if (!albumId) return undefined;
  const distinctDiscCovers = resolveDistinctDiscCoversForAlbum(albumId, track.serverId);
  return albumCoverRefForSong(
    { ...track, albumId },
    distinctDiscCovers,
    serverScope,
  );
}

export function artistCoverRef(
  artistId: string,
  fetchCoverArtId?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  const entry = resolveArtistCoverEntry(artistId, fetchCoverArtId);
  if (!entry) {
    const id = (fetchCoverArtId ?? artistId).trim();
    return coverEntryToRef(
      { cacheKind: 'artist', cacheEntityId: id, fetchCoverArtId: id },
      serverScope,
    );
  }
  return coverEntryToRef(entry, serverScope);
}

export function coverRefFromEntity(
  cacheKind: CoverCacheKind,
  cacheEntityId: string,
  fetchCoverArtId?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  const entry =
    cacheKind === 'artist'
      ? resolveArtistCoverEntry(cacheEntityId, fetchCoverArtId)
      : resolveAlbumCoverEntry(cacheEntityId, fetchCoverArtId);
  if (!entry) {
    const id = (fetchCoverArtId ?? cacheEntityId).trim();
    return coverEntryToRef(
      { cacheKind, cacheEntityId: id, fetchCoverArtId: id },
      serverScope,
    );
  }
  return coverEntryToRef(entry, serverScope);
}

/** @deprecated Prefer entity helpers in {@link resolveEntry}. */
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
  if (!playbackSid) return { kind: 'playback' };
  const activeSid = useAuthStore.getState().activeServerId;
  if (playbackSid === activeSid) return { kind: 'playback' };
  return coverServerScopeForServerId(playbackSid);
}
