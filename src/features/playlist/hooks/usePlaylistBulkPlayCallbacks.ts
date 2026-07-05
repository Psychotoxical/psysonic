import { useCallback } from 'react';
import type { Track } from '@/lib/media/trackTypes';
import { enqueuePlaylistAll, playPlaylistAll, shufflePlaylistAll } from '@/features/playlist/utils/playlistBulkPlayActions';

export interface PlaylistBulkPlayCallbacksDeps {
  songsLength: number;
  id: string | undefined;
  tracks: Track[];
  playTrack: (track: Track, queue: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
}

export interface PlaylistBulkPlayCallbacks {
  handlePlayAll: () => void;
  handleShuffleAll: () => void;
  handleEnqueueAll: () => void;
}

export function usePlaylistBulkPlayCallbacks(deps: PlaylistBulkPlayCallbacksDeps): PlaylistBulkPlayCallbacks {
  const { songsLength, id, tracks, playTrack, enqueue } = deps;

  const handlePlayAll = useCallback(
    () => playPlaylistAll({ songsLength, id, tracks, playTrack, enqueue }),
    [songsLength, id, tracks, playTrack, enqueue],
  );

  const handleShuffleAll = useCallback(
    () => shufflePlaylistAll({ songsLength, id, tracks, playTrack, enqueue }),
    [songsLength, id, tracks, playTrack, enqueue],
  );

  const handleEnqueueAll = useCallback(
    () => enqueuePlaylistAll({ songsLength, id, tracks, playTrack, enqueue }),
    [songsLength, id, tracks, playTrack, enqueue],
  );

  return { handlePlayAll, handleShuffleAll, handleEnqueueAll };
}
