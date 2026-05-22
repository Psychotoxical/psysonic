import { useMemo } from 'react';
import { usePlayerStore } from '../store/playerStore';
import type { QueueItemRef, Track } from '../store/playerStoreTypes';
import { toQueueItemRefs } from '../utils/library/queueItemRef';

/**
 * Stable queue selectors (queue thin-state). Consumers migrate onto these in
 * phase 3. Today they read the canonical `queue: Track[]`; once it's dropped
 * (phase 4) the implementations move to the resolver (`queueTrackResolver`)
 * without changing these signatures.
 */

/** The track at a queue index, or null. */
export function useQueueTrackAt(idx: number): Track | null {
  return usePlayerStore(s => s.queue[idx] ?? null);
}

/** The currently playing track, or null. */
export function useCurrentTrack(): Track | null {
  return usePlayerStore(s => s.currentTrack);
}

/** The whole queue as thin refs (derived; memoized on queue/server identity). */
export function useQueueItems(): QueueItemRef[] {
  const queue = usePlayerStore(s => s.queue);
  const serverId = usePlayerStore(s => s.queueServerId);
  return useMemo(() => toQueueItemRefs(serverId ?? '', queue), [serverId, queue]);
}
