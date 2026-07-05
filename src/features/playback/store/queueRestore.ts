import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import { resolveBatch } from './queueTrackResolver';

/**
 * Full-queue restore (thin-state, decision B). The player store rehydrates the
 * whole thin `queueItems` ref list from localStorage on startup; this eagerly
 * resolves every ref into the resolver cache so the queue UI / playback paths
 * have real `Track` metadata. `resolveBatch` does the index batch
 * (`library_get_tracks_batch`, ≤100 refs/call) → `getSong` network fallback (P8)
 * internally, so the queue is never empty even with the index off (the P6
 * default — every ref still resolves via getSong).
 *
 * Clears the restore-pending sentinel (`queueItemsIndex`) once the eager resolve
 * is dispatched so it runs at most once; `queueItems` stays canonical. Legacy
 * pre-thin-state blobs that only carried `queueRefs` were normalised into
 * `queueItems` by the store's persist `merge`, so this reads `queueItems` only.
 */
export async function hydrateQueueFromIndex(): Promise<void> {
  const player = usePlayerStore.getState();

  // Restore-pending sentinel: `partialize` writes `queueItemsIndex` alongside
  // the full `queueItems` on every persist, so a fresh rehydrate carries it
  // back. Normal in-memory mutations keep `queueItems` canonical but never set
  // the index, so its presence — not a non-empty `queueItems` — marks "this
  // restored queue still needs an eager resolve". Without it (steady state /
  // later server switch) there is nothing to do.
  const restorePending =
    player.queueItemsIndex !== undefined || (player.queueRefs?.length ?? 0) > 0;
  if (!restorePending) return;

  let refs: QueueItemRef[] = player.queueItems ?? [];
  if (refs.length === 0 && player.queueRefs?.length) {
    const rawSid = player.queueServerId ?? useAuthStore.getState().activeServerId ?? '';
    const sid = canonicalQueueServerKey(rawSid);
    refs = player.queueRefs.map(trackId => ({ serverId: sid, trackId }));
  }

  // Clear the restore-pending sentinel + any legacy refs; `queueItems` stays the
  // canonical mirror. Done up front so a later resolve never re-triggers.
  usePlayerStore.setState({
    queueItemsIndex: undefined,
    queueRefs: undefined,
    queueRefsIndex: undefined,
  });

  if (refs.length === 0) return;

  // Eager resolve of the whole queue into the resolver cache (best-effort —
  // index batch when ready, else getSong window fallback so the queue plays
  // even with the index off). Failures leave refs as placeholders until a row
  // scrolls into view and the resolver bridge fetches them.
  try {
    await resolveBatch(refs);
  } catch {
    /* best-effort */
  }
}
