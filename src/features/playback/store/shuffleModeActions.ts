/**
 * Persistent shuffle mode — pure helpers and the remembered pre-shuffle order.
 *
 * Turning shuffle on physically reorders the queue (the tracks after the current
 * one) and remembers the order it came from; turning it off puts that order back.
 * The toggle itself lives with the other queue mutations in
 * `queueMutationActions` — it pushes an undo snapshot and syncs the queue to the
 * server like every other mutation, and those modules reach back into the player
 * store. This file stays free of that so it can be imported anywhere.
 *
 * The alternative design — leaving `queueItems` alone and only *playing* in a
 * hidden random order — was rejected deliberately: "what plays next" is derived
 * from the list order in four places (manual next, the gapless successor, the
 * chain preload, the crossfade/AutoDJ plan), the engine is handed the next track
 * ~30 s ahead with no way to take it back, and the server play-queue (and Orbit
 * guests) only ever see the list order.
 */

import type { QueueItemRef } from '@/lib/media/trackTypes';

/** Module-level, like the other non-render queue state: the UI never reads it. */
let originalOrder: string[] = [];

export function getShuffleOriginalOrder(): string[] {
  return originalOrder;
}

/**
 * Sets the remembered order. Called when shuffle is switched on, cleared when it
 * is switched off, and seeded from storage on boot — shuffle survives a restart,
 * so the order it can be undone to has to survive with it.
 */
export function setShuffleOriginalOrder(order: string[]): void {
  originalOrder = order;
}

export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Reorders `items` back into `order`, matching by track id.
 *
 * Ids can repeat (the same track may sit in the queue twice), so each id consumes
 * one ref at a time rather than filtering. Refs the remembered order does not
 * know about — enqueued, radio-topped-up or auto-added while shuffle was on —
 * keep their relative order and go to the end: they were never part of the
 * original list, so there is no position to restore them to.
 */
export function restoreOriginalOrder(items: QueueItemRef[], order: string[]): QueueItemRef[] {
  const pools = new Map<string, QueueItemRef[]>();
  for (const ref of items) {
    const pool = pools.get(ref.trackId);
    if (pool) pool.push(ref);
    else pools.set(ref.trackId, [ref]);
  }

  const restored: QueueItemRef[] = [];
  for (const trackId of order) {
    const ref = pools.get(trackId)?.shift();
    if (ref) restored.push(ref);
  }

  const restoredSet = new Set(restored);
  return [...restored, ...items.filter(ref => !restoredSet.has(ref))];
}
