import type { SubsonicArtist } from '@/lib/api/subsonicTypes';

/**
 * Navidrome's `/api/artist?role=composer` can include artists whose
 * `stats.composer.albumCount` is zero (performer-only credits with no composer
 * tags). Drop them from the Composers browse catalog.
 */
export function filterArtistsWithRoleAlbumCredits(artists: SubsonicArtist[]): SubsonicArtist[] {
  return artists.filter(a => (a.albumCount ?? 0) > 0);
}
