import { useCallback } from 'react';
import type { Track } from '../store/playerStoreTypes';
import { enqueuePlaylistAll, playPlaylistAll, shufflePlaylistAll } from '../utils/playlistBulkPlayActions';

export interface PlaylistBulkPlayCallbacksDeps {
  songsLength: number;
  id: string | undefined;
  tracks: Track[];
  touchPlaylist: (id: string) => void;
  playTrack: (track: Track, queue: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
}

export interface PlaylistBulkPlayCallbacks {
  handlePlayAll: () => void;
  handleShuffleAll: () => void;
  handleEnqueueAll: () => void;
}

export function usePlaylistBulkPlayCallbacks(deps: PlaylistBulkPlayCallbacksDeps): PlaylistBulkPlayCallbacks {
  const { songsLength, id, tracks, touchPlaylist, playTrack, enqueue } = deps;

  const handlePlayAll = useCallback(
    () => playPlaylistAll({ songsLength, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songsLength, id, tracks, touchPlaylist, playTrack, enqueue],
  );

  const handleShuffleAll = useCallback(
    () => shufflePlaylistAll({ songsLength, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songsLength, id, tracks, touchPlaylist, playTrack, enqueue],
  );

  const handleEnqueueAll = useCallback(
    () => enqueuePlaylistAll({ songsLength, id, tracks, touchPlaylist, playTrack, enqueue }),
    [songsLength, id, tracks, touchPlaylist, playTrack, enqueue],
  );

  return { handlePlayAll, handleShuffleAll, handleEnqueueAll };
}
