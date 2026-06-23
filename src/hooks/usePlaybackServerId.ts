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
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const playingServerId = usePlayerStore(
    s => s.queueItems[s.queueIndex]?.serverId ?? '',
  );
  const activeServerId = useAuthStore(s => s.activeServerId);
  return useMemo(
    () => getPlaybackServerId(),
    // getPlaybackServerId() reads global queue/auth state; the listed values
    // are intentional recompute triggers, not direct inputs to the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queueServerId, queueIndex, playingServerId, activeServerId],
  );
}
