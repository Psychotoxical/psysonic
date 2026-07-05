import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { getCachedTrack, placeholderTrack, applyQueueOverrides } from './queueTrackResolver';

/**
 * Dual-write bridge (thin-state phase 4): rebuild the legacy `queue: Track[]`
 * from the canonical `QueueItemRef[]` after a ref-native mutation. Each ref's
 * track is sourced from the supplied `pools` (the previous queue + any tracks
 * just handed to the mutation) by id — **purely structural**: no resolver cache
 * read and no F4 override merge (display still applies those), so the derived
 * array is byte-identical to the old fat-array mutation result. The ref is the
 * source of truth for the queue-only flags. A ref with no pooled track falls
 * back to a placeholder (does not happen during dual-write, where every ref's
 * track is in hand). Removed in the final step together with `queue: Track[]`.
 */
export function bridgeQueueFromItems(items: QueueItemRef[], pools: Track[][]): Track[] {
  const byId = new Map<string, Track>();
  for (const pool of pools) {
    for (const t of pool) if (!byId.has(t.id)) byId.set(t.id, t);
  }
  return items.map(ref => {
    const base = byId.get(ref.trackId);
    if (!base) return placeholderTrack(ref);
    if (
      base.autoAdded === ref.autoAdded &&
      base.radioAdded === ref.radioAdded &&
      base.playNextAdded === ref.playNextAdded
    ) {
      return base;
    }
    return { ...base, autoAdded: ref.autoAdded, radioAdded: ref.radioAdded, playNextAdded: ref.playNextAdded };
  });
}

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
