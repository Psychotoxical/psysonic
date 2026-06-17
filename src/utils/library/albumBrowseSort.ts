import type { SubsonicAlbum } from '../../api/subsonicTypes';
import type { LibrarySortClause } from '../../api/library';

export type AlbumBrowseSort = 'alphabeticalByName' | 'alphabeticalByArtist';

export function albumSortClauses(sort: AlbumBrowseSort): LibrarySortClause[] {
  // Always append a secondary key so albums sharing the primary key keep a
  // stable order — by artist groups each artist's albums by title (rather than
  // an undefined order within the artist), mirroring `sortSubsonicAlbums`.
  if (sort === 'alphabeticalByArtist') {
    return [
      { field: 'artist', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ];
  }
  return [
    { field: 'name', dir: 'asc' },
    { field: 'artist', dir: 'asc' },
  ];
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
