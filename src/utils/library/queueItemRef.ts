import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { canonicalQueueServerKey } from '../server/serverIndexKey';

/**
 * Derive thin `QueueItemRef`s from a `Track[]` queue (thin-state). Per-item
 * `serverId` is the canonical server index key — every writer normalizes here
 * so refs are unambiguous across mixed-server queues (same `trackId` on two
 * servers must collide on nothing, since the resolver uses `serverId:trackId`).
 * Queue-only flags are carried through, others omitted to keep the persisted /
 * derived list small. Pure — no store import beyond the canonicalizer, so both
 * `playerStore` (persist) and the resolver bridge can use it without a
 * circular dependency.
 */
export function toQueueItemRefs(serverId: string, queue: Track[]): QueueItemRef[] {
  const canonicalId = canonicalQueueServerKey(serverId);
  return queue.map(t => {
    const ref: QueueItemRef = { serverId: canonicalId, trackId: t.id };
    if (t.autoAdded) ref.autoAdded = true;
    if (t.radioAdded) ref.radioAdded = true;
    if (t.playNextAdded) ref.playNextAdded = true;
    return ref;
  });
}
