import { useMemo } from 'react';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { getPlaybackServerId } from '../utils/playback/playbackServer';

/**
 * Subsonic server that owns the current queue / stream (may differ from the browsed
 * server). Use for Now Playing metadata without calling `ensurePlaybackServerActive`.
 */
export function usePlaybackServerId(): string {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueLength = usePlayerStore(s => s.queueItems.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  return useMemo(
    () => getPlaybackServerId(),
    [queueServerId, queueLength, activeServerId],
  );
}
