// Owed-scrobble queue.
//
// A play that fails on a recoverable error is kept and retried. Unlike the star
// override in `pendingStarSync`, which this is modelled on, the queue is
// persisted: a star click can be repeated by the user, a play cannot — the user
// never sees the failure and cannot listen to the track again to produce it.
//
// Entries are keyed on the *destination* (preset + host + user), not the account
// id, so they survive the disconnect-and-reconnect that repairs a rejected
// session. One entry per (play, destination) pair: a play that reached two of
// three destinations only retries the third.

import type { MusicNetworkStore } from './store';
import {
  isSameScrobbleTarget,
  scrobbleTargetRef,
  type PersistedAccount,
  type QueuedScrobble,
  type ScrobbleTargetRef,
} from '../core/accounts';
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

/**
 * Stable key for a destination. JSON rather than a separator character: account
 * ids, hosts and usernames are user data, and any literal separator could occur
 * inside them — a NUL byte would additionally make this file binary to git.
 */
function targetKey(target: ScrobbleTargetRef): string {
  return JSON.stringify([target.presetId, target.baseUrl, target.username]);
}

/** Identity of an owed play: one destination, one moment of listening. */
function identityOf(entry: QueuedScrobble): string {
  return JSON.stringify([
    entry.target.presetId,
    entry.target.baseUrl,
    entry.target.username,
    entry.event.timestamp,
  ]);
}

/** Same play, same destination — a wire that timed out twice owes one scrobble. */
function isSameEntry(a: QueuedScrobble, account: PersistedAccount, event: ScrobbleEvent): boolean {
  return isSameScrobbleTarget(a.target, scrobbleTargetRef(account))
    && a.event.timestamp === event.timestamp;
}

/**
 * Applies the two ceilings that keep the queue finite: expiry, then the entry cap
 * with the oldest play evicted first — a fresh scrobble is likelier to still be
 * accepted. Every write goes through here, including the flush's merge, or a long
 * flush could write back entries the live path had already evicted.
 */
function bounded(queue: readonly QueuedScrobble[], now: number): QueuedScrobble[] {
  const live = queue.filter(e => !isExpired(e, now));
  if (live.length <= SCROBBLE_QUEUE_MAX) return live;
  return [...live]
    .sort((a, b) => a.event.timestamp - b.event.timestamp)
    .slice(live.length - SCROBBLE_QUEUE_MAX);
}

/**
 * Adds one owed play. Pure over the current queue so it can be unit-tested and so
 * the caller decides when to persist.
 */
export function withEnqueued(
  queue: QueuedScrobble[],
  account: PersistedAccount,
  event: ScrobbleEvent,
  now: number = Date.now(),
): QueuedScrobble[] {
  // Same array back on a no-op, so callers can skip a persist write: a wire
  // failing repeatedly on one play must not rewrite the auth blob each time.
  if (queue.some(e => isSameEntry(e, account, event))) return queue;
  return bounded(
    [
      ...queue,
      {
        target: scrobbleTargetRef(account),
        event,
        attempts: 1,
        nextAttemptAt: now + backoffFor(1),
      },
    ],
    now,
  );
}

export interface FlushDeps extends OrchestratorDeps {
  /**
   * Destinations eligible for a scrobble right now — the same filter the live
   * path applies. An entry matching none of them is left alone rather than
   * dropped: the account may be mid-reconnect, and expiry is what bounds the
   * wait. (The master toggle is handled one level up.)
   *
   * A function, not an array: delivery mutates accounts (the session-error flag),
   * and a snapshot taken before the loop would still report the old value for
   * every remaining entry.
   */
  targets(): readonly PersistedAccount[];
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
  const report = () => onProgress?.([...settled, ...pending]);
  // Destinations that already refused during this pass. Whatever the cause —
  // rate limit, dead session, provider outage — it applies to every entry for
  // that destination, so trying the rest would only add failed requests against
  // a provider that has already said no, across a backlog of up to 500.
  const refused = new Set<string>();

  for (const entry of queue) {
    pending.shift();
    // Re-read per entry: a backlog against a slow provider can span many minutes,
    // and one timestamp taken before the loop would make every retry due at once.
    const now = clock();

    if (isExpired(entry, now)) {
      report();
      continue;
    }

    if (refused.has(targetKey(entry.target))) {
      settled.push(entry);
      report();
      continue;
    }

    // A destination can hold more than one account: self-hosted presets stay in
    // the add-list after connecting, and with no reconnect button a user facing
    // "Reconnect needed" plausibly just connects the same host again. Connect
    // appends, so the stale flagged account comes first — prefer a healthy one,
    // or the backlog would wait behind a dead account until it expired.
    const matches = deps
      .targets()
      .filter(a => isSameScrobbleTarget(scrobbleTargetRef(a), entry.target));
    const account = matches.find(a => !a.sessionError) ?? matches[0];
    // No eligible destination right now: disconnected, switched off, or being
    // reconnected. Keep the play — that is the whole point of keying on the
    // destination instead of the account id — and let expiry bound the wait.
    if (!account) {
      settled.push(entry);
      report();
      continue;
    }

    // Session rejected and not repaired yet: every entry for this account would
    // fail identically. Hold without attempting: no request, no backoff advance,
    // and the entry waits for the reconnect, which can take the user days.
    if (account.sessionError) {
      settled.push(entry);
      report();
      continue;
    }

    if (entry.nextAttemptAt > now) {
      settled.push(entry);
      report();
      continue;
    }

    const outcome = await deliver(account, 'scrobble', entry.event, deps);
    if (outcome === 'ok' || outcome === 'drop') {
      report();
      continue;
    }
    refused.add(targetKey(entry.target));
    // No attempt ceiling: NETWORK is also what an offline machine produces, so
    // counting failures would delete the head of the queue after a day offline
    // while the entry advertises a fortnight. Expiry bounds the lifetime, and the
    // refusal set above bounds the request rate to one per destination per pass.
    const attempts = entry.attempts + 1;
    settled.push({ ...entry, attempts, nextAttemptAt: clock() + backoffFor(attempts) });
    report();
  }
  return settled;
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
    const merged = bounded([...remaining, ...arrivedDuringFlush], clock());
    const unchanged =
      merged.length === live.length && merged.every((e, i) => e === live[i]);
    if (!unchanged) store.setScrobbleQueue(merged);
  };

  persist(await flushQueue(before, deps, clock, persist));
}
