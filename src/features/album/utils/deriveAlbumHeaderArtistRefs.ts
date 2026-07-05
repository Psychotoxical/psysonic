import type { SubsonicAlbum, SubsonicOpenArtistRef, SubsonicSong } from '@/lib/api/subsonicTypes';
import { coerceOpenArtistRefs } from '@/lib/api/openArtistRefs';

function nonEmpty(refs: SubsonicOpenArtistRef[]): refs is SubsonicOpenArtistRef[] {
  return refs.length > 0;
}

/**
 * Structured album-artist credits without the album-detail Song fallback.
 * Used wherever only the album object is available (cards, rails). Prefers the
 * OpenSubsonic `artists` array; falls back to legacy `artist` + `artistId`.
 */
export function deriveAlbumArtistRefs(album: SubsonicAlbum): SubsonicOpenArtistRef[] {
  const albumArtists = coerceOpenArtistRefs(album.artists);
  if (nonEmpty(albumArtists)) return albumArtists;
  const display = album.displayArtist?.trim();
  const legacy = album.artist?.trim();
  const name = display || legacy || '—';
  const id = album.artistId?.trim();
  return id ? [{ id, name }] : [{ name }];
}

/** Single-line album-artist label for cards and rails (matches `deriveAlbumArtistRefs`). */
export function albumArtistDisplayName(album: SubsonicAlbum): string {
  const parts = deriveAlbumArtistRefs(album)
    .map(r => r.name?.trim() ?? '')
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
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
  const albumArtists = coerceOpenArtistRefs(album.artists);
  if (nonEmpty(albumArtists)) return albumArtists;
  for (const s of songs) {
    const songAlbumArtists = coerceOpenArtistRefs(s.albumArtists);
    if (nonEmpty(songAlbumArtists)) return songAlbumArtists;
  }
  return deriveAlbumArtistRefs(album);
}
