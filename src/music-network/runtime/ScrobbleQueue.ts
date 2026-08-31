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

/**
 * Give-up ceiling per entry. Expiry alone is not enough: the wires collapse every
 * unrecognised provider error into NETWORK, so a permanently rejected request
 * (bad parameters, suspended key) looks transient and would be re-sent hourly for
 * two weeks. At the capped backoff this is roughly a day of trying.
 */
export const SCROBBLE_MAX_ATTEMPTS = 24;

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
  queue: QueuedScrobble[],
  accountId: string,
  event: ScrobbleEvent,
  now: number = Date.now(),
): QueuedScrobble[] {
  // Same array back on a no-op, so callers can skip a persist write: a wire
  // failing repeatedly on one play must not rewrite the auth blob each time.
  if (queue.some(e => isSameEntry(e, accountId, event))) return queue;
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
  clock: () => number = Date.now,
  onProgress?: (remaining: QueuedScrobble[]) => void,
): Promise<QueuedScrobble[]> {
  const settled: QueuedScrobble[] = [];
  const pending = [...queue];
  for (const entry of queue) {
    pending.shift();
    // Re-read per entry: a backlog against a slow provider can span many minutes,
    // and a timestamp taken before the loop would make every retry due at once.
    const now = clock();
    const account = deps.targets.find(a => a.id === entry.accountId);
    // Destination gone or switched off, or the play aged out while we waited.
    if (!account || isExpired(entry, now)) {
      onProgress?.([...settled, ...pending]);
      continue;
    }
    // Session rejected: hold without attempting. Every entry for this account
    // would fail the same way, burning the give-up ceiling on a condition only the
    // user can clear — and each failure would rewrite the account record. The
    // backlog waits for the reconnect; expiry still bounds how long.
    if (account.sessionError) {
      settled.push(entry);
      onProgress?.([...settled, ...pending]);
      continue;
    }
    if (entry.nextAttemptAt > now) {
      settled.push(entry);
      onProgress?.([...settled, ...pending]);
      continue;
    }
    const outcome = await deliver(account, 'scrobble', entry.event, deps);
    const attempts = entry.attempts + 1;
    // A destination that keeps refusing is not always honest about why: the wires
    // collapse unrecognised provider errors into NETWORK, so a permanently bad
    // request would otherwise be re-sent hourly for the full 14 days.
    if (outcome === 'retry' && attempts <= SCROBBLE_MAX_ATTEMPTS) {
      settled.push({ ...entry, attempts, nextAttemptAt: clock() + backoffFor(attempts) });
    }
    onProgress?.([...settled, ...pending]);
  }
  return settled;
}

/** Identity of an owed play: one destination, one moment of listening. */
function identityOf(entry: QueuedScrobble): string {
  return entry.accountId + '~' + entry.event.timestamp;
}


/**
 * Store-bound wrapper: reads, delivers, persists.
 *
 * Persists after every entry rather than once at the end. Delivery can span many
 * minutes, and a quit or crash mid-loop would otherwise leave every already-sent
 * play in the queue, to be sent a second time on the next launch. Each write is
 * merged against a fresh read, because the live path keeps enqueueing throughout —
 * writing the snapshot-derived list alone would drop the plays that failed while
 * the flush was running, the exact loss this feature exists to prevent.
 */
export async function flushScrobbleQueue(
  store: MusicNetworkStore,
  deps: FlushDeps,
  clock: () => number = Date.now,
): Promise<void> {
  const before = store.getState().scrobbleQueue;
  if (before.length === 0) return;
  const seen = new Set(before.map(identityOf));

  const persist = (remaining: readonly QueuedScrobble[]) => {
    const live = store.getState().scrobbleQueue;
    const arrivedDuringFlush = live.filter(e => !seen.has(identityOf(e)));
    const merged = [...remaining, ...arrivedDuringFlush];
    const unchanged =
      merged.length === live.length && merged.every((e, i) => e === live[i]);
    if (!unchanged) store.setScrobbleQueue(merged);
  };

  persist(await flushQueue(before, deps, clock, persist));
}
