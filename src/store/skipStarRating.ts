import type { Track } from './playerStoreTypes';
import { useAuthStore } from './authStore';
import { usePlayerStore } from './playerStore';
import { queueSongRating } from './pendingStarSync';
/**
 * Skip → 1★ behaviour: every user-initiated `next()` on an unrated track
 * counts in `authStore.skipStarManualSkipCountsByKey` (persisted). Once the
 * configured threshold is crossed, the track is auto-rated 1★ — both on the
 * Subsonic server and in local Zustand state (queue + currentTrack + the
 * override map that QueuePanel reads).
 *
 * Natural track end (incl. gapless advance) does NOT count; it clears the
 * threshold counter elsewhere. Already-rated tracks are skipped silently.
 */
export function applySkipStarOnManualNext(skippedTrack: Track | null, manual: boolean): void {
  if (!manual || !skippedTrack) return;
  const id = skippedTrack.id;
  const adv = useAuthStore.getState().recordSkipStarManualAdvance(id);
  if (!adv?.crossedThreshold) return;
  const live = usePlayerStore.getState();
  const fromQueue = live.queue.find(t => t.id === id);
  const cur =
    live.userRatingOverrides[id] ??
    fromQueue?.userRating ??
    skippedTrack.userRating ??
    0;
  if (cur >= 1) return;
  // F4: optimistic 1★ (patches queue + currentTrack + override) and retried
  // server sync via the central helper; the override clears on success.
  queueSongRating(id, 1);
}
