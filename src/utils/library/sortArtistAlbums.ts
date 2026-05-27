import type { SubsonicAlbum } from '../../api/subsonicTypes';

export type ArtistAlbumSort = 'releaseType' | 'yearDesc' | 'yearAsc';

export function sortArtistAlbums(
  albums: SubsonicAlbum[],
  sort: ArtistAlbumSort,
): SubsonicAlbum[] {
  if (sort === 'releaseType') return albums;

  const out = [...albums];
  out.sort((a, b) => {
    const ay = a.year ?? 0;
    const by = b.year ?? 0;
    if (ay !== by) return sort === 'yearDesc' ? by - ay : ay - by;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return out;
}
