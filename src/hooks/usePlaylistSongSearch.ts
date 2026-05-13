import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { search } from '../api/subsonicSearch';
import type { SubsonicSong } from '../api/subsonicTypes';

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
    if (!searchOpen || !searchQuery.trim()) { setSearchResults([]); return; }
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await search(searchQuery, { songCount: 20, artistCount: 0, albumCount: 0 });
        const existingIds = new Set(songs.map(s => s.id));
        setSearchResults(res.songs.filter(s => !existingIds.has(s.id)));
      } catch {}
      setSearching(false);
    }, 350);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchQuery, searchOpen, songs]);

  return { searchResults, setSearchResults, searching };
}
