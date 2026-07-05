import { api, libraryFilterParams } from '@/lib/api/subsonicClient';
import type { SubsonicAlbum, SubsonicGenre, SubsonicSong } from '@/lib/api/subsonicTypes';

export async function getGenres(): Promise<SubsonicGenre[]> {
  const data = await api<{ genres: { genre: SubsonicGenre | SubsonicGenre[] } }>('getGenres.view', {
    ...libraryFilterParams(),
  });
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

/** Single page of songs for a genre (Subsonic `getSongsByGenre`, supported by Navidrome). */
export async function getSongsByGenre(genre: string, count = 500, offset = 0): Promise<SubsonicSong[]> {
  const data = await api<{ songsByGenre: { song: SubsonicSong | SubsonicSong[] } }>('getSongsByGenre.view', {
    genre,
    count,
    offset,
    _t: Date.now(),
    ...libraryFilterParams(),
  });
  const raw = data.songsByGenre?.song;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Every song in a genre, paginated until exhausted. Capped to keep the queue and the
 * burst of server requests bounded for very large genres (a handful of sequential pages).
 */
export async function fetchAllSongsByGenre(genre: string, cap = 5000): Promise<SubsonicSong[]> {
  const PAGE = 500;
  const songs: SubsonicSong[] = [];
  for (let offset = 0; songs.length < cap; offset += PAGE) {
    const page = await getSongsByGenre(genre, PAGE, offset);
    songs.push(...page);
    if (page.length < PAGE) break;
  }
  return songs.length > cap ? songs.slice(0, cap) : songs;
}
