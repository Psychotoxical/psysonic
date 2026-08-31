// Owed-scrobble queue.
//
// A play that fails on a transient error is kept and retried. Unlike the star
// override in `pendingStarSync`, which this is modelled on, the queue is
// persisted: a star click can be repeated by the user, a play cannot. The user
// never sees the failure and cannot listen to the track again to produce it.
//
// The queue holds one entry per (play, destination) pair, so a play that reached
// two of three destinations only retries the third.

import type { MusicNetworkStore } from './store';
import type { PersistedAccount, QueuedScrobble } from '../core/accounts';
import type { ScrobbleEvent } from '../core/types';
import { deliver, type OrchestratorDeps } from './ScrobbleOrchestrator';

/**
 * Last.fm rejects scrobbles older than 14 days and other providers are no more
 * generous, so an older entry is undeliverable rather than merely late.
 */
export const SCROBBLE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Ceiling on stored entries; the oldest play is dropped first. */
export const SCROBBLE_QUEUE_MAX = 500;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** Doubling backoff, capped — 1, 2, 4 … 60 minutes. */
export function backoffFor(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

function isExpired(entry: QueuedScrobble, now: number): boolean {
  return now - entry.event.timestamp > SCROBBLE_MAX_AGE_MS;
}

/** Same play, same destination — a wire that timed out twice owes one scrobble. */
function isSameEntry(a: QueuedScrobble, accountId: string, event: ScrobbleEvent): boolean {
  return a.accountId === accountId && a.event.timestamp === event.timestamp;
}

/**
 * Adds one owed play. Pure over the current queue so it can be unit-tested and
 * so the caller decides when to persist.
 */
export function withEnqueued(
  queue: readonly QueuedScrobble[],
  accountId: string,
  event: ScrobbleEvent,
  now: number = Date.now(),
): QueuedScrobble[] {
  if (queue.some(e => isSameEntry(e, accountId, event))) return [...queue];
  const next: QueuedScrobble[] = [
    ...queue,
    { accountId, event, attempts: 1, nextAttemptAt: now + backoffFor(1) },
  ];
  const live = next.filter(e => !isExpired(e, now));
  if (live.length <= SCROBBLE_QUEUE_MAX) return live;
  // Oldest play first: a fresh scrobble is likelier to still be accepted.
  return [...live]
    .sort((a, b) => a.event.timestamp - b.event.timestamp)
    .slice(live.length - SCROBBLE_QUEUE_MAX);
}

export interface FlushDeps extends OrchestratorDeps {
  /**
   * Destinations eligible for a scrobble right now — the same filter the live
   * path applies. An entry for anything else is dropped: the user either removed
   * that account or switched it off, and delivering anyway would override an
   * explicit setting. (The master toggle is handled one level up, where it holds
   * the queue instead of discarding it.)
   */
  targets: readonly PersistedAccount[];
}

/**
 * Attempts every entry that is due, sequentially — a queue that built up over an
 * offline stretch must not turn into a burst of parallel requests at one
 * provider. Returns the queue as it should be persisted.
 */
export async function flushQueue(
  queue: readonly QueuedScrobble[],
  deps: FlushDeps,
  now: number = Date.now(),
): Promise<QueuedScrobble[]> {
  const next: QueuedScrobble[] = [];
  for (const entry of queue) {
    const account = deps.targets.find(a => a.id === entry.accountId);
    // Destination removed, or the play aged out while we waited.
    if (!account || isExpired(entry, now)) continue;
    if (entry.nextAttemptAt > now) {
      next.push(entry);
      continue;
    }
    const outcome = await deliver(account, 'scrobble', entry.event, deps);
    if (outcome === 'ok' || outcome === 'drop') continue;
    const attempts = entry.attempts + 1;
    next.push({ ...entry, attempts, nextAttemptAt: now + backoffFor(attempts) });
  }
  return next;
}

/** Identity of an owed play: one destination, one moment of listening. */
function identityOf(entry: QueuedScrobble): string {
  return entry.accountId + '~' + entry.event.timestamp;
}

/**
 * Store-bound wrapper: reads, delivers, writes back.
 *
 * Delivery can span minutes, and the live path keeps enqueueing while it runs, so
 * the result is merged against a fresh read rather than written blind. Writing the
 * snapshot-derived list alone would drop every play that failed during the flush —
 * the exact loss this feature exists to prevent.
 */
export async function flushScrobbleQueue(
  store: MusicNetworkStore,
  deps: FlushDeps,
  now: number = Date.now(),
): Promise<void> {
  const before = store.getState().scrobbleQueue;
  if (before.length === 0) return;
  const next = await flushQueue(before, deps, now);

  const seen = new Set(before.map(identityOf));
  const arrivedDuringFlush = store
    .getState()
    .scrobbleQueue.filter(e => !seen.has(identityOf(e)));
  const merged = [...next, ...arrivedDuringFlush];

  const latest = store.getState().scrobbleQueue;
  const unchanged =
    merged.length === latest.length && merged.every((e, i) => e === latest[i]);
  if (!unchanged) store.setScrobbleQueue(merged);
}
