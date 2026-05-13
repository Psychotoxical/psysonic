import { useMemo, useState } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';

export type AlbumSortKey = 'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration';

interface UseAlbumDetailSortArgs {
  songs: SubsonicSong[] | undefined;
  filterText: string;
  starredSongs: Set<string>;
  ratings: Record<string, number>;
  userRatingOverrides: Record<string, number>;
}

interface UseAlbumDetailSortResult {
  sortKey: AlbumSortKey;
  sortDir: 'asc' | 'desc';
  handleSort: (key: AlbumSortKey) => void;
  displayedSongs: SubsonicSong[];
}

/**
 * Sort + text-filter pipeline for the album track list. Click cycle on a
 * header column: asc → desc → off (back to `natural` order). Other
 * columns reset to asc on first click.
 *
 * Rating reads use the same priority as the row renderer
 * (`ratings[id] ?? userRatingOverrides[id] ?? song.userRating`) so the
 * sort matches the visible stars during optimistic updates.
 */
export function useAlbumDetailSort({
  songs,
  filterText,
  starredSongs,
  ratings,
  userRatingOverrides,
}: UseAlbumDetailSortArgs): UseAlbumDetailSortResult {
  const [sortKey, setSortKey] = useState<AlbumSortKey>('natural');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortClickCount, setSortClickCount] = useState(0);

  const handleSort = (key: AlbumSortKey) => {
    if (key === 'natural') return;
    if (sortKey === key) {
      const nextCount = sortClickCount + 1;
      if (nextCount >= 3) {
        setSortKey('natural');
        setSortDir('asc');
        setSortClickCount(0);
      } else {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        setSortClickCount(nextCount);
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
      setSortClickCount(1);
    }
  };

  const displayedSongs = useMemo(() => {
    if (!songs) return [];
    const q = filterText.trim().toLowerCase();
    if (!q && sortKey === 'natural') return songs;
    let result = [...songs];
    if (q) result = result.filter(s => s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q));
    if (sortKey !== 'natural') {
      result.sort((a, b) => {
        let av: string | number;
        let bv: string | number;
        switch (sortKey) {
          case 'title': av = a.title; bv = b.title; break;
          case 'artist': av = a.artist ?? ''; bv = b.artist ?? ''; break;
          case 'album': av = a.album ?? ''; bv = b.album ?? ''; break;
          case 'favorite':
            av = starredSongs.has(a.id) ? 1 : 0;
            bv = starredSongs.has(b.id) ? 1 : 0;
            break;
          case 'rating':
            av = ratings[a.id] ?? userRatingOverrides[a.id] ?? a.userRating ?? 0;
            bv = ratings[b.id] ?? userRatingOverrides[b.id] ?? b.userRating ?? 0;
            break;
          case 'duration': av = a.duration ?? 0; bv = b.duration ?? 0; break;
          default: av = a.title; bv = b.title;
        }
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortDir === 'asc' ? av - bv : bv - av;
        }
        return sortDir === 'asc' ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      });
    }
    return result;
  }, [songs, filterText, sortKey, sortDir, starredSongs, ratings, userRatingOverrides]);

  return { sortKey, sortDir, handleSort, displayedSongs };
}
