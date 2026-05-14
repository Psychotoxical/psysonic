import type { SubsonicAlbum, SubsonicOpenArtistRef, SubsonicSong } from '../../api/subsonicTypes';

function nonEmpty(refs: SubsonicOpenArtistRef[] | undefined): refs is SubsonicOpenArtistRef[] {
  return !!refs && refs.length > 0;
}

/**
 * OpenSubsonic album credits for the album-detail header.
 * Prefer `albumArtists` on the album payload, then on any child song (Navidrome
 * often attaches the structured list only on songs); fall back to legacy
 * `artist` + `artistId` strings.
 */
export function deriveAlbumHeaderArtistRefs(
  album: SubsonicAlbum,
  songs: SubsonicSong[],
): SubsonicOpenArtistRef[] {
  if (nonEmpty(album.albumArtists)) return album.albumArtists;
  for (const s of songs) {
    if (nonEmpty(s.albumArtists)) return s.albumArtists;
  }
  const name = album.artist?.trim() || '—';
  const id = album.artistId?.trim();
  return id ? [{ id, name }] : [{ name }];
}
