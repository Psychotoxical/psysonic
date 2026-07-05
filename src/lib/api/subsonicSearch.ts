import { api, libraryFilterParams } from '@/lib/api/subsonicClient';
import { searchQueryIsFtsSafe } from '@/lib/library/searchQueryFtsSafe';
import type {
  SearchResults,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

/**
 * search3 sometimes returns duplicate or junk artist rows with **zero** albums (e.g. Navidrome indexing).
 * Drop only rows that explicitly report `albumCount === 0`; keep artists when the field is absent.
 * Thanks to zunoz for the report on the Psysonic Discord.
 */
export function filterSearchArtistsWithNoAlbums(artists: SubsonicArtist[]): SubsonicArtist[] {
  return artists.filter((a) => a.albumCount !== 0);
}

export async function search(
  query: string,
  options?: {
    albumCount?: number;
    artistCount?: number;
    songCount?: number;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<SearchResults> {
  if (!query.trim()) return { artists: [], albums: [], songs: [] };
  if (!searchQueryIsFtsSafe(query)) return { artists: [], albums: [], songs: [] };
  const data = await api<{
    searchResult3: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    };
  }>(
    'search3.view',
    {
      query,
      artistCount: options?.artistCount ?? 5,
      albumCount: options?.albumCount ?? 5,
      songCount: options?.songCount ?? 10,
      ...libraryFilterParams(),
    },
    options?.timeout ?? 15000,
    options?.signal,
  );
  const r = data.searchResult3 ?? {};
  return {
    artists: filterSearchArtistsWithNoAlbums(r.artist ?? []),
    albums: r.album ?? [],
    songs: r.song ?? [],
  };
}

/**
 * Song-only paginated search3. Tolerates empty query — Navidrome returns all songs
 * ordered by title in that case; strict Subsonic implementations may return nothing.
 * Caller handles empty results gracefully (Tracks page falls back to its random pool).
 */
export async function searchSongsPaged(query: string, songCount: number, songOffset: number): Promise<SubsonicSong[]> {
  if (!searchQueryIsFtsSafe(query.trim())) return [];
  const data = await api<{ searchResult3: { song?: SubsonicSong[] } }>('search3.view', {
    query,
    artistCount: 0,
    albumCount: 0,
    songCount,
    songOffset,
    ...libraryFilterParams(),
  });
  return data.searchResult3?.song ?? [];
}
