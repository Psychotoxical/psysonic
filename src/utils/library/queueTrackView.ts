import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { getCachedTrack, placeholderTrack, applyQueueOverrides } from './queueTrackResolver';

/**
 * Queue thin-state phase 4: turn a `QueueItemRef` into a display `Track` for the
 * upcoming consumer migration off `queue: Track[]`.
 *
 * Resolver-first: cache → caller fallback (the legacy `queue[idx]` Track during
 * the dual-write transition) → placeholder. Queue-only flags come from the ref
 * (they are not in the index/cache); session star/rating overrides (F4) are
 * merged last. Pure synchronous read — **no fetch, no cache mutation** — so it is
 * safe to call from render (the resolver's `getCachedTrack` is a plain `cache.get`
 * for exactly this reason; see the freeze fix in queueTrackResolver).
 */
export function resolveQueueTrack(ref: QueueItemRef, fallback?: Track): Track {
  const base = getCachedTrack(ref) ?? fallback ?? placeholderTrack(ref);
  // Carry the ref's queue-only flags onto the resolved track without mutating the
  // cached object (a render-time mutation is what caused the earlier render loop).
  const needsFlags =
    base.autoAdded !== ref.autoAdded ||
    base.radioAdded !== ref.radioAdded ||
    base.playNextAdded !== ref.playNextAdded;
  const flagged = needsFlags
    ? { ...base, autoAdded: ref.autoAdded, radioAdded: ref.radioAdded, playNextAdded: ref.playNextAdded }
    : base;
  return applyQueueOverrides(flagged);
}

/**
 * Resolve a whole ref list to display `Track`s (non-React call sites: snapshots,
 * hot-cache planning, sync). Same per-item rules as {@link resolveQueueTrack};
 * `fallbacks[i]` is the legacy `queue[i]` during the dual-write transition.
 */
export function getQueueTracksView(refs: QueueItemRef[], fallbacks?: Track[]): Track[] {
  return refs.map((ref, i) => resolveQueueTrack(ref, fallbacks?.[i]));
}
