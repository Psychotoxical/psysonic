import type { SubsonicAlbum, SubsonicOpenArtistRef, SubsonicSong } from '../../api/subsonicTypes';

function nonEmpty(refs: SubsonicOpenArtistRef[] | undefined): refs is SubsonicOpenArtistRef[] {
  return !!refs && refs.length > 0;
}

/**
 * Structured album-artist credits without the album-detail Song fallback.
 * Used wherever only the album object is available (cards, rails). Prefers the
 * OpenSubsonic `artists` array; falls back to legacy `artist` + `artistId`.
 */
export function deriveAlbumArtistRefs(album: SubsonicAlbum): SubsonicOpenArtistRef[] {
  if (nonEmpty(album.artists)) return album.artists;
  const name = album.artist?.trim() || '—';
  const id = album.artistId?.trim();
  return id ? [{ id, name }] : [{ name }];
}

/**
 * OpenSubsonic album credits for the album-detail header.
 * Prefer the album's `artists` array, then any child song's `albumArtists`
 * (some servers only attach the structured list at song level); fall back to
 * the legacy `artist` + `artistId` strings.
 */
export function deriveAlbumHeaderArtistRefs(
  album: SubsonicAlbum,
  songs: SubsonicSong[],
): SubsonicOpenArtistRef[] {
  if (nonEmpty(album.artists)) return album.artists;
  for (const s of songs) {
    if (nonEmpty(s.albumArtists)) return s.albumArtists;
  }
  return deriveAlbumArtistRefs(album);
}
