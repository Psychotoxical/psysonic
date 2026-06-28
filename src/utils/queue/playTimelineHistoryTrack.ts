import { usePlayerStore } from '../../store/playerStore';
import type { QueueItemRef } from '../../store/playerStoreTypes';
import { getQueueTracksView, resolveQueueTrack } from '../library/queueTrackView';
import { sameQueueTrackId } from '../playback/queueIdentity';

/**
 * Play a timeline history row without replacing the queue. Upcoming slots jump
 * in place; everything else inserts after the current track (play-now semantics).
 */
export function playTimelineHistoryTrack(
  serverId: string,
  trackId: string,
  canonicalQueue?: QueueItemRef[],
): void {
  const track = resolveQueueTrack({ serverId, trackId });
  const state = usePlayerStore.getState();
  const { queueItems, queueIndex, currentTrack, playTrack } = state;
  const lookup = canonicalQueue ?? queueItems;
  const absIdx = lookup.findIndex(r => sameQueueTrackId(r.trackId, trackId));

  if (
    absIdx === queueIndex
    && currentTrack
    && sameQueueTrackId(currentTrack.id, trackId)
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
