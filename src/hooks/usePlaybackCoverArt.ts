import { useMemo } from 'react';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { playbackCoverArtForId } from '../utils/playback/playbackServer';

/** Cover art for the playing queue — uses {@link queueServerId} when it differs from the browsed server. */
export function usePlaybackCoverArt(coverId: string | undefined, size: number) {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueLength = usePlayerStore(s => s.queue.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const servers = useAuthStore(s => s.servers);

  return useMemo(() => {
    if (!coverId) return { src: '', cacheKey: '' };
    return playbackCoverArtForId(coverId, size);
  }, [coverId, size, queueServerId, queueLength, activeServerId, servers]);
}
