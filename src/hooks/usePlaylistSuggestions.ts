import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicSong } from '../api/subsonicTypes';

export interface PlaylistSuggestionsResult {
  suggestions: SubsonicSong[];
  setSuggestions: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  loadingSuggestions: boolean;
  loadSuggestions: (currentSongs: SubsonicSong[]) => Promise<void>;
}

export function usePlaylistSuggestions(songs: SubsonicSong[], playlistId: string | undefined): PlaylistSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SubsonicSong[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const loadSuggestions = useCallback(async (currentSongs: SubsonicSong[]) => {
    if (!currentSongs.length) return;
    // Count genres across playlist songs, pick the most common one
    const genreCounts: Record<string, number> = {};
    for (const s of currentSongs) {
      if (s.genre) genreCounts[s.genre] = (genreCounts[s.genre] ?? 0) + 1;
    }
    const genres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
    // Fall back to no genre filter if none of the songs have genre tags
    const genre = genres.length > 0 ? genres[Math.floor(Math.random() * Math.min(3, genres.length))][0] : undefined;
    const existingIds = new Set(currentSongs.map(s => s.id));
    setLoadingSuggestions(true);
    setSuggestions([]);
    try {
      const random = await getRandomSongs(25, genre);
      setSuggestions(random.filter(s => !existingIds.has(s.id)).slice(0, 10));
    } catch {}
    setLoadingSuggestions(false);
  }, []);

  useEffect(() => {
    if (songs.length > 0) loadSuggestions(songs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId]);

  return { suggestions, setSuggestions, loadingSuggestions, loadSuggestions };
}
