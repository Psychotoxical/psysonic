import type { SubsonicAlbum, SubsonicSong } from '../api/subsonicTypes';

export type CoverArtResolvableSong = Pick<SubsonicSong, 'id' | 'coverArt'> & {
  albumId?: string | null;
};

/**
 * Subsonic songs often set `coverArt` to the track id (no art). Use `albumId` only then;
 * keep a distinct `coverArt` when it differs from the song id (per-track art).
 */
export function resolveSubsonicSongCoverArtId(song: CoverArtResolvableSong): string | undefined {
  const albumId = song.albumId?.trim();
  const cover = song.coverArt?.trim();
  const songId = song.id?.trim();
  if (cover && (!songId || cover !== songId)) return cover;
  if (albumId) return albumId;
  if (cover) return cover;
  return undefined;
}

/** Queue / player `Track` and mini-player rows — same rules as Subsonic songs. */
export function resolvePlaybackTrackCoverArtId(
  track: CoverArtResolvableSong | null | undefined,
): string | undefined {
  if (!track) return undefined;
  return resolveSubsonicSongCoverArtId({
    id: track.id,
    coverArt: track.coverArt,
    albumId: track.albumId ?? '',
  });
}

/**
 * Artist top tracks: use the album row's `coverArt` when the grid already warmed it.
 */
export function resolveArtistPageSongCoverArtId(
  song: Pick<SubsonicSong, 'id' | 'coverArt' | 'albumId' | 'album'>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
): string | undefined {
  const album = song.albumId
    ? albums.find(a => a.id === song.albumId)
    : albums.find(a => a.name === song.album);
  const albumCover = album?.coverArt?.trim();
  const songId = song.id?.trim();
  // Album row `coverArt` can echo the track id (no art) — do not prefer it over albumId.
  if (albumCover && (!songId || albumCover !== songId)) return albumCover;
  return resolveSubsonicSongCoverArtId(song);
}
