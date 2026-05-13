import type React from 'react';
import type { TFunction } from 'i18next';
import type { SubsonicPlaylist, SubsonicSong } from '../api/subsonicTypes';
import { showToast } from '../utils/toast';

export interface PlaylistSongMutationsDeps {
  songs: SubsonicSong[];
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  savePlaylist: (updatedSongs: SubsonicSong[], prevCount?: number) => Promise<void>;
  setSuggestions: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  setSearchResults: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  playlist: SubsonicPlaylist | null;
  t: TFunction;
}

export interface PlaylistSongMutations {
  removeSong: (idx: number) => void;
  addSong: (song: SubsonicSong) => void;
}

export function usePlaylistSongMutations(deps: PlaylistSongMutationsDeps): PlaylistSongMutations {
  const { songs, setSongs, savePlaylist, setSuggestions, setSearchResults, playlist, t } = deps;

  const removeSong = (idx: number) => {
    const prevCount = songs.length;
    const next = songs.filter((_, i) => i !== idx);
    setSongs(next);
    savePlaylist(next, prevCount);
  };

  const addSong = (song: SubsonicSong) => {
    if (songs.some(s => s.id === song.id)) return;
    const scrollHost = document.querySelector('.main-content') as HTMLElement | null;
    const savedScroll = scrollHost?.scrollTop ?? 0;
    const next = [...songs, song];
    setSongs(next);
    savePlaylist(next);
    setSuggestions(prev => prev.filter(s => s.id !== song.id));
    setSearchResults(prev => prev.filter(s => s.id !== song.id));
    if (scrollHost) {
      requestAnimationFrame(() => { scrollHost.scrollTop = savedScroll; });
    }
    showToast(t('playlists.addSuccess', { count: 1, playlist: playlist?.name }));
  };

  return { removeSong, addSong };
}
