import { useMemo, useSyncExternalStore } from 'react';
import { usePlayerStore } from '../store/playerStore';
import type { QueueItemRef, Track } from '../store/playerStoreTypes';
import { toQueueItemRefs } from '../utils/library/queueItemRef';
import {
  applyQueueOverrides,
  getCachedTrack,
  getQueueResolverVersion,
  subscribeQueueResolver,
} from '../utils/library/queueTrackResolver';

/**
 * Stable queue selectors (queue thin-state). Resolver-first: read the resolved
 * track from the cache, falling back to the canonical `queue: Track[]` until
 * phase 4 drops it; session star/rating overrides (F4) merged on read. Consumers
 * migrate onto these in phase 3; the signatures stay stable through phase 4.
 */

/** The track at a queue index, or null. */
export function useQueueTrackAt(idx: number): Track | null {
  const base = usePlayerStore(s => s.queue[idx] ?? null);
  const serverId = usePlayerStore(s => s.queueServerId);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const version = useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);
  return useMemo(() => {
    if (!base) return null;
    const cached = serverId ? getCachedTrack({ serverId, trackId: base.id }) : undefined;
    return applyQueueOverrides(cached ?? base);
  // version drives re-resolution as the cache fills; overrides drive the merge.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, serverId, starredOverrides, userRatingOverrides, version]);
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
