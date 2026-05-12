import { api, libraryFilterParams } from './subsonicClient';
import type { SubsonicAlbum, SubsonicGenre } from './subsonicTypes';

export async function getGenres(): Promise<SubsonicGenre[]> {
  const data = await api<{ genres: { genre: SubsonicGenre | SubsonicGenre[] } }>('getGenres.view');
  const raw = data.genres?.genre;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export async function getAlbumsByGenre(genre: string, size = 50, offset = 0): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum | SubsonicAlbum[] } }>('getAlbumList2.view', {
    type: 'byGenre',
    genre,
    size,
    offset,
    _t: Date.now(),
    ...libraryFilterParams(),
  });
  const raw = data.albumList2?.album;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}
