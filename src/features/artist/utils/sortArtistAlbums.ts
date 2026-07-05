import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

export type ArtistAlbumYearOrder = 'yearDesc' | 'yearAsc';

export function sortArtistAlbumsByYear(
  albums: SubsonicAlbum[],
  order: ArtistAlbumYearOrder,
): SubsonicAlbum[] {
  const out = [...albums];
  out.sort((a, b) => {
    const ay = a.year ?? 0;
    const by = b.year ?? 0;
    if (ay !== by) return order === 'yearDesc' ? by - ay : ay - by;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return out;
}
