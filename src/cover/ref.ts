import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { coverServerScopeForServerId } from './serverScope';
import type { SubsonicSong } from '../api/subsonicTypes';
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

export function rememberAlbumDistinctDiscCovers(
  albumId: string,
  songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber' | 'coverArt' | 'id' | 'albumId'>>,
): void {
  const id = albumId.trim();
  if (!id) return;
  albumDistinctDiscCoversByAlbumId.set(id, albumHasDistinctDiscCovers(songs));
}

export function forgetAlbumDistinctDiscCovers(albumId: string): void {
  albumDistinctDiscCoversByAlbumId.delete(albumId.trim());
}

export type DistinctDiscCoversHint = Pick<
  SubsonicSong,
  'discNumber' | 'coverArt' | 'id' | 'albumId'
>;

/**
 * Whether per-disc `mf-*` cache slots apply — from album tracklist memory or song hints
 * when the album page has not been opened yet.
 */
export function resolveDistinctDiscCoversForAlbum(
  albumId: string,
  fetchCoverArtId?: string | null,
  songHint?: DistinctDiscCoversHint,
): boolean {
  const album = albumId.trim();
  if (!album) return false;

  const known = albumDistinctDiscCoversByAlbumId.get(album);
  if (known === true) return true;
  if (known === false) return false;

  if (songHint) {
    const cover = songHint.coverArt?.trim();
    if ((songHint.discNumber ?? 1) > 1 && Boolean(cover && cover !== album)) return true;
  }

  const fetch = fetchCoverArtId?.trim();
  if (fetch && fetch !== album && fetch.startsWith('mf-')) return true;

  return false;
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

export function albumCoverRefForSong(
  song: Pick<SubsonicSong, 'albumId' | 'coverArt' | 'id' | 'discNumber'>,
  distinctDiscCovers?: boolean,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | undefined {
  const albumId = song.albumId?.trim();
  const distinct =
    distinctDiscCovers
    ?? (albumId ? resolveDistinctDiscCoversForAlbum(albumId, song.coverArt, song) : false);
  const entry = resolveTrackCoverEntry(song, distinct);
  return entry ? coverEntryToRef(entry, serverScope) : undefined;
}

export function albumCoverRefForPlayback(
  track: Pick<SubsonicSong, 'coverArt' | 'id' | 'discNumber'> & { albumId?: string | null },
  serverScope: CoverServerScope = resolvePlaybackCoverScope(),
): CoverArtRef | undefined {
  const albumId = track.albumId?.trim();
  if (!albumId) return undefined;
  const distinctDiscCovers = resolveDistinctDiscCoversForAlbum(
    albumId,
    track.coverArt,
    { ...track, albumId } as DistinctDiscCoversHint,
  );
  return albumCoverRefForSong(
    { ...track, albumId } as Pick<SubsonicSong, 'albumId' | 'coverArt' | 'id' | 'discNumber'>,
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
