import type { QueueItemRef } from '@/lib/media/trackTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { activeServerProfileId, profileIdFromQueueRef } from '@/lib/media/trackServerScope';

/**
 * Store-reading queue-scope helpers. These read the live player store (current
 * queue + pinned server), so they stay in the playback feature; the pure stamp
 * / classify helpers they build on live in `@/lib/media/trackServerScope`.
 */

/** Canonical queue ref at `index`, or the currently playing slot. */
export function queueItemRefAt(index?: number): QueueItemRef | null {
  const { queueItems, queueIndex } = usePlayerStore.getState();
  if (!queueItems?.length) return null;
  const idx = index ?? queueIndex;
  if (idx < 0 || idx >= queueItems.length) return null;
  return queueItems[idx] ?? null;
}

function refsForServerProfile(refs: QueueItemRef[], profileId: string): QueueItemRef[] {
  if (!profileId) return [];
  return refs.filter(ref => queueRefProfileIdForTarget(ref, profileId));
}

function queueRefProfileIdForTarget(ref: QueueItemRef, profileId: string): boolean {
  const fromRef = profileIdFromQueueRef(ref);
  if (fromRef) return fromRef === profileId;
  const pin = usePlayerStore.getState().queueServerId;
  if (pin) return (resolveServerIdForIndexKey(pin) || pin) === profileId;
  return profileId === (activeServerProfileId() ?? '');
}

/** Queue refs that belong to a saved server profile (mixed-queue safe). */
export function filterQueueRefsForServerProfile(refs: QueueItemRef[], profileId: string): QueueItemRef[] {
  return refsForServerProfile(refs, profileId);
}

/** Queue refs that belong to the browsed (active) server — for export/save on mixed queues. */
export function filterQueueRefsForActiveServer(refs: QueueItemRef[]): QueueItemRef[] {
  const activeId = activeServerProfileId();
  if (!activeId) return [];
  return refsForServerProfile(refs, activeId);
}

export function activeServerQueueTrackIds(refs: QueueItemRef[]): string[] {
  return filterQueueRefsForActiveServer(refs).map(r => r.trackId);
}
