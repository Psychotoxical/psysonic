import React from 'react';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import type { SubsonicSong } from '../api/subsonicTypes';
import { usePlayerStore } from '../store/playerStore';

export interface PlaylistStarRatingDeps {
  ratings: Record<string, number>;
  setRatings: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  starredSongs: Set<string>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export interface PlaylistStarRatingActions {
  handleRate: (songId: string, rating: number) => void;
  handleToggleStar: (song: SubsonicSong, e: React.MouseEvent) => void;
}

export function usePlaylistStarRating(deps: PlaylistStarRatingDeps): PlaylistStarRatingActions {
  const { setRatings, starredSongs, setStarredSongs } = deps;
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);

  const handleRate = (songId: string, rating: number) => {
    setRatings(prev => ({ ...prev, [songId]: rating }));
    usePlayerStore.getState().setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  };

  const handleToggleStar = (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const isStarred = song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id);
    setStarredSongs(prev => {
      const next = new Set(prev);
      isStarred ? next.delete(song.id) : next.add(song.id);
      return next;
    });
    setStarredOverride(song.id, !isStarred);
    (isStarred ? unstar(song.id, 'song') : star(song.id, 'song')).catch(() => {});
  };

  return { handleRate, handleToggleStar };
}
