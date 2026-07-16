import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { search } from '@/lib/api/subsonicSearch';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

export interface PlaylistSongSearchResult {
  searchResults: SubsonicSong[];
  setSearchResults: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  searching: boolean;
}

export function usePlaylistSongSearch(
  songs: SubsonicSong[],
  searchOpen: boolean,
  searchQuery: string,
): PlaylistSongSearchResult {
  const [searchResults, setSearchResults] = useState<SubsonicSong[]>([]);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!searchOpen || !searchQuery.trim()) { setSearchResults([]); return; }
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await search(searchQuery, { songCount: 20, artistCount: 0, albumCount: 0 });
        const existingIds = new Set(songs.map(s => s.id));
        setSearchResults(res.songs.filter(s => !existingIds.has(s.id)));
      } catch { /* ignore: best-effort */ }
      setSearching(false);
    }, 350);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchQuery, searchOpen, songs]);

  return { searchResults, setSearchResults, searching };
}
