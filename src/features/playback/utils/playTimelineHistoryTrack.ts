import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import { getQueueTracksView, resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { resolveBatch } from '@/features/playback/store/queueTrackResolver';
import { findQueueItemRefIndex, sameQueueItemRef } from '@/features/playback/utils/playback/queueIdentity';

/**
 * Play a timeline history row without replacing the queue. Upcoming slots jump
 * in place; everything else inserts after the current track (play-now semantics).
 */
export async function playTimelineHistoryTrack(
  serverId: string,
  trackId: string,
  canonicalQueue?: QueueItemRef[],
): Promise<void> {
  const ref = { serverId, trackId };
  await resolveBatch([ref]);
  const track = resolveQueueTrack(ref);
  const state = usePlayerStore.getState();
  const { queueItems, queueIndex, currentTrack, playTrack } = state;
  const lookup = canonicalQueue ?? queueItems;
  const absIdx = findQueueItemRefIndex(lookup, ref);
  const currentRef = queueIndex >= 0 ? lookup[queueIndex] : undefined;

  if (
    absIdx === queueIndex
    && currentTrack
    && currentRef
    && sameQueueItemRef(currentRef, ref)
  ) {
    return;
  }

  if (absIdx > queueIndex) {
    playTrack(track, undefined, undefined, undefined, absIdx);
    return;
  }

  if (!currentTrack || queueItems.length === 0) {
    playTrack(track, [track]);
    return;
  }

  const resolved = getQueueTracksView(queueItems);
  const insertAt = Math.min(queueIndex + 1, resolved.length);
  const newQueue = [
    ...resolved.slice(0, insertAt),
    track,
    ...resolved.slice(insertAt),
  ];
  playTrack(track, newQueue, undefined, undefined, insertAt);
}
