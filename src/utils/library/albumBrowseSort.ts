import type { SubsonicAlbum } from '../../api/subsonicTypes';
import type { LibrarySortClause } from '../../api/library';

export type AlbumBrowseSort = 'alphabeticalByName' | 'alphabeticalByArtist';

export function albumSortClauses(sort: AlbumBrowseSort): LibrarySortClause[] {
  if (sort === 'alphabeticalByArtist') {
    return [{ field: 'artist', dir: 'asc' }];
  }
  return [{ field: 'name', dir: 'asc' }];
}

export function sortSubsonicAlbums(albums: SubsonicAlbum[], sort: AlbumBrowseSort): SubsonicAlbum[] {
  const out = [...albums];
  out.sort((a, b) =>
    sort === 'alphabeticalByArtist'
      ? a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist),
  );
  return out;
}
