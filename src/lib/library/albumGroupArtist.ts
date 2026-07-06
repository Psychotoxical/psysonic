import type { LibraryTrackDto } from '@/lib/api/library';

/** Navidrome / OpenSubsonic album row display artist — non-empty albumArtist wins. */
export function pickAlbumGroupArtist(
  trackArtist: string | null | undefined,
  albumArtist: string | null | undefined,
): string {
  const aa = albumArtist?.trim();
  if (aa) return aa;
  return trackArtist?.trim() ?? '';
}

/** Album credit name from grouped local tracks (`MAX(album_artist)` else `MIN(artist)` parity). */
export function pickAlbumGroupArtistFromTrackDtos(tracks: LibraryTrackDto[]): string {
  const albumArtists = tracks
    .map(t => t.albumArtist?.trim())
    .filter((name): name is string => !!name);
  if (albumArtists.length > 0) {
    const sorted = [...albumArtists].sort((a, b) => a.localeCompare(b));
    return sorted[sorted.length - 1]!;
  }
  const performers = tracks
    .map(t => t.artist?.trim())
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b));
  return performers[0] ?? '';
}

/**
 * Best-effort album-artist id for offline aggregates — prefer a track row whose
 * performer name matches the album credit (index artist-table parity).
 */
export function resolveAlbumCreditArtistId(
  tracks: LibraryTrackDto[],
  creditName: string,
): string {
  const key = creditName.trim().toLowerCase();
  if (key) {
    const match = tracks.find(
      t => t.artistId && t.artist?.trim().toLowerCase() === key,
    );
    if (match?.artistId) return match.artistId;
  }
  return tracks.find(t => t.artistId)?.artistId ?? '';
}
