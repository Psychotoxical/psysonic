import { useMemo } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import { usePlayerStore } from '../store/playerStore';
import { songToTrack } from '../utils/songToTrack';
import { getDisplayedSongs, type PlaylistSortDir, type PlaylistSortKey } from '../utils/playlistDisplayedSongs';

export interface PlaylistDerivedOptions {
  filterText: string;
  sortKey: PlaylistSortKey;
  sortDir: PlaylistSortDir;
  ratings: Record<string, number>;
  starredSongs: Set<string>;
}

export interface PlaylistDerived {
  existingIds: Set<string>;
  tracks: Track[];
  displayedSongs: SubsonicSong[];
  displayedTracks: Track[];
  isFiltered: boolean;
}

export function usePlaylistDerived(songs: SubsonicSong[], opts: PlaylistDerivedOptions): PlaylistDerived {
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const { filterText, sortKey, sortDir, ratings, starredSongs } = opts;

  const existingIds = useMemo(() => new Set(songs.map(s => s.id)), [songs]);
  const tracks = useMemo(() => songs.map(songToTrack), [songs]);

  const displayedSongs = useMemo(
    () => getDisplayedSongs(songs, {
      filterText, sortKey, sortDir,
      ratings, userRatingOverrides, starredOverrides, starredSongs,
    }),
    [songs, filterText, sortKey, sortDir, ratings, userRatingOverrides, starredOverrides, starredSongs],
  );
  const displayedTracks = useMemo(
    () => displayedSongs === songs ? tracks : displayedSongs.map(songToTrack),
    [displayedSongs, songs, tracks],
  );
  const isFiltered = displayedSongs !== songs;

  return { existingIds, tracks, displayedSongs, displayedTracks, isFiltered };
}
