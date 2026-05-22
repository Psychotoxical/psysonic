import type { QueueItemRef, Track } from '../../store/playerStoreTypes';

/**
 * Derive thin `QueueItemRef`s from a `Track[]` queue (thin-state). Per-item
 * `serverId` is the single playback server in v1; queue-only flags are carried
 * through, others omitted to keep the persisted/derived list small. Pure — no
 * store import, so both `playerStore` (persist) and the resolver bridge can use
 * it without a circular dependency.
 */
export function toQueueItemRefs(serverId: string, queue: Track[]): QueueItemRef[] {
  return queue.map(t => {
    const ref: QueueItemRef = { serverId, trackId: t.id };
    if (t.autoAdded) ref.autoAdded = true;
    if (t.radioAdded) ref.radioAdded = true;
    if (t.playNextAdded) ref.playNextAdded = true;
    return ref;
  });
}
