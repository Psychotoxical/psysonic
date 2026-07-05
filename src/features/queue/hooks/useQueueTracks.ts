import { useMemo, useSyncExternalStore } from 'react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  getQueueResolverVersion,
  subscribeQueueResolver,
} from '@/features/playback/store/queueTrackResolver';

/**
 * Stable queue selectors (queue thin-state). The store is refs-canonical now:
 * full `Track`s come from the resolver cache (placeholder until a fetch lands),
 * with session star/rating overrides (F4) merged on read via resolveQueueTrack.
 */

/** The track at a queue index, or null. */
export function useQueueTrackAt(idx: number): Track | null {
  const ref = usePlayerStore(s => s.queueItems[idx] ?? null);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const version = useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);
  return useMemo(() => {
    if (!ref) return null;
    return resolveQueueTrack(ref);
  // version drives re-resolution as the cache fills; overrides drive the merge.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, starredOverrides, userRatingOverrides, version]);
}

/** The currently playing track, or null. */
export function useCurrentTrack(): Track | null {
  return usePlayerStore(s => s.currentTrack);
}

/** The whole queue as thin refs (the canonical list). */
export function useQueueItems(): QueueItemRef[] {
  return usePlayerStore(s => s.queueItems);
}
