import React, { useMemo } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { usePlayerStore } from '../store/playerStore';

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1950;

// Columns that support 3-state sorting (asc → desc → reset)
const SORTABLE_COLUMNS = new Set(['title', 'artist', 'album', 'rating', 'duration']);

export type SortDir = 'asc' | 'desc';

export interface FavoritesSongFilteringDeps {
  songs: SubsonicSong[];
  sortKey: string;
  setSortKey: React.Dispatch<React.SetStateAction<string>>;
  sortDir: SortDir;
  setSortDir: React.Dispatch<React.SetStateAction<SortDir>>;
  sortClickCount: number;
  setSortClickCount: React.Dispatch<React.SetStateAction<number>>;
  selectedArtist: string | null;
  selectedGenres: string[];
  yearRange: [number, number];
  ratings: Record<string, number>;
}

export interface FavoritesSongFilteringResult {
  filteredSongs: SubsonicSong[];
  visibleSongs: SubsonicSong[];
  handleSortClick: (key: string) => void;
  getSortIndicator: (key: string) => React.ReactNode;
}

export function useFavoritesSongFiltering(deps: FavoritesSongFilteringDeps): FavoritesSongFilteringResult {
  const {
    songs, sortKey, setSortKey, sortDir, setSortDir, sortClickCount, setSortClickCount,
    selectedArtist, selectedGenres, yearRange, ratings,
  } = deps;
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);

  const handleSortClick = (key: string) => {
    if (!SORTABLE_COLUMNS.has(key)) return;

    if (sortKey === key) {
      const nextCount = sortClickCount + 1;
      if (nextCount >= 3) {
        // Reset to natural order (favorite addition order)
        setSortKey('natural');
        setSortDir('asc');
        setSortClickCount(0);
      } else {
        // Toggle direction
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        setSortClickCount(nextCount);
      }
    } else {
      // Start new sort on this column
      setSortKey(key);
      setSortDir('asc');
      setSortClickCount(1);
    }
  };

  const getSortIndicator = (key: string) => {
    if (sortKey !== key) return null;
    if (sortClickCount === 0) return null;
    return sortDir === 'asc' ? <ArrowUp size={12} style={{ marginLeft: 4, opacity: 0.7 }} /> : <ArrowDown size={12} style={{ marginLeft: 4, opacity: 0.7 }} />;
  };

  // ── Filter logic ─────────────────────────────────────────────────────────
  const filteredSongs = useMemo(() => {
    return songs.filter(s => {
      // Remove unfavorited
      if (starredOverrides[s.id] === false) return false;

      // Artist filter
      if (selectedArtist) {
        const artistMatch = s.artistId === selectedArtist ||
                           s.artist === selectedArtist ||
                           s.albumArtist === selectedArtist;
        if (!artistMatch) return false;
      }

      // Genre filter
      if (selectedGenres.length > 0) {
        const songGenre = s.genre || '';
        const hasMatchingGenre = selectedGenres.some(g =>
          songGenre.toLowerCase().includes(g.toLowerCase())
        );
        if (!hasMatchingGenre) return false;
      }

      // Year range filter — only applied when range is non-default; songs without year are excluded
      if (yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) {
        if (s.year === undefined || s.year < yearRange[0] || s.year > yearRange[1]) return false;
      }

      return true;
    });
  }, [songs, starredOverrides, selectedArtist, selectedGenres, yearRange]);

  // ── Sort logic ───────────────────────────────────────────────────────────
  const visibleSongs = useMemo(() => {
    if (sortKey === 'natural' || sortClickCount === 0) {
      return filteredSongs;
    }

    const sorted = [...filteredSongs];
    const multiplier = sortDir === 'asc' ? 1 : -1;

    return sorted.sort((a, b) => {
      switch (sortKey) {
        case 'title':
          return multiplier * (a.title || '').localeCompare(b.title || '');
        case 'artist':
          return multiplier * ((a.artist || '').localeCompare(b.artist || ''));
        case 'album':
          return multiplier * ((a.album || '').localeCompare(b.album || ''));
        case 'rating': {
          const ratingA = ratings[a.id] ?? userRatingOverrides[a.id] ?? a.userRating ?? 0;
          const ratingB = ratings[b.id] ?? userRatingOverrides[b.id] ?? b.userRating ?? 0;
          return multiplier * (ratingA - ratingB);
        }
        case 'duration':
          return multiplier * ((a.duration || 0) - (b.duration || 0));
        default:
          return 0;
      }
    });
  }, [filteredSongs, sortKey, sortDir, sortClickCount, ratings, userRatingOverrides]);

  return { filteredSongs, visibleSongs, handleSortClick, getSortIndicator };
}
