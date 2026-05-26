import { coverCacheEnsure } from '../api/coverCache';
import { getDiskSrc } from './diskSrcCache';
import { getDiskSrcForGrid } from './diskSrcLookup';
import { coverIndexKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority } from './types';

type EnsureJob = {
  storageKey: string;
  ref: CoverArtRef;
  tier: CoverArtTier;
  priority: CoverPrefetchPriority;
  /** Larger = closer to viewport / more recently bumped — dequeued first within the same priority band. */
  orderKey: number;
  resolve: (r: { hit: boolean; path: string }) => void;
};

import {
  coverTrafficBackgroundPaused,
  coverTrafficServerSwitchPaused,
} from './coverTraffic';

/** Parallel Rust cover ensures (visible UI; library backfill is native-only). */
export const COVER_ENSURE_MAX_INFLIGHT = 10;
const MAX_INFLIGHT = COVER_ENSURE_MAX_INFLIGHT;
/** Drop stale scroll-ahead work so the queue cannot grow without bound. */
const MAX_QUEUE = 96;

let inflight = 0;
let queue: EnsureJob[] = [];
let nextOrderKey = 0;
const inflightStorageKeys = new Set<string>();

function priorityRank(p: CoverPrefetchPriority): number {
  return p === 'high' ? 0 : p === 'middle' ? 1 : 2;
}

function sortQueue(): void {
  queue.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return b.orderKey - a.orderKey;
  });
}

function trimQueue(): void {
  while (queue.length > MAX_QUEUE) {
    let worstIdx = 0;
    for (let i = 1; i < queue.length; i += 1) {
      const a = queue[worstIdx]!;
      const b = queue[i]!;
      const rankA = priorityRank(a.priority);
      const rankB = priorityRank(b.priority);
      if (rankB > rankA || (rankB === rankA && b.orderKey < a.orderKey)) {
        worstIdx = i;
      }
    }
    const [job] = queue.splice(worstIdx, 1);
    job.resolve({ hit: false, path: '' });
    ensureInflight.delete(job.storageKey);
  }
}

function coverInflightKey(ref: CoverArtRef): string {
  return `${coverIndexKeyFromRef(ref)}:${ref.coverArtId}`;
}

/** Serialize ensures per cover ID so we do not re-download for every tier. */
const coverDownloadTail = new Map<string, Promise<unknown>>();

function ensureForCover(
  ref: CoverArtRef,
  tier: CoverArtTier,
  priority: CoverPrefetchPriority,
) {
  const key = coverInflightKey(ref);
  const tail = coverDownloadTail.get(key) ?? Promise.resolve();
  const run = tail.then(() => coverCacheEnsure(ref, tier, priority));
  coverDownloadTail.set(key, run.catch(() => {}));
  return run;
}

function findQueuedJob(storageKey: string): EnsureJob | undefined {
  return queue.find(j => j.storageKey === storageKey);
}

function bumpJob(job: EnsureJob, priority?: CoverPrefetchPriority): void {
  if (priority && priorityRank(priority) < priorityRank(job.priority)) {
    job.priority = priority;
  }
  job.orderKey = ++nextOrderKey;
  sortQueue();
}

function pump(): void {
  if (coverTrafficServerSwitchPaused()) return;
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const next = queue[0]!;
    if (coverTrafficBackgroundPaused() && next.priority !== 'high') {
      break;
    }
    const job = queue.shift()!;
    inflight += 1;
    inflightStorageKeys.add(job.storageKey);
    void ensureForCover(job.ref, job.tier, job.priority)
      .then(r => job.resolve({ hit: r.hit, path: r.path }))
      .catch(() => job.resolve({ hit: false, path: '' }))
      .finally(() => {
        inflight -= 1;
        inflightStorageKeys.delete(job.storageKey);
        pump();
      });
  }
}

const ensureInflight = new Map<string, Promise<{ hit: boolean; path: string }>>();

/** Move a queued job ahead of older scroll-ahead work (viewport / prefetch bump). */
export function coverEnsureBump(
  storageKey: string,
  priority: CoverPrefetchPriority = 'high',
): void {
  const job = findQueuedJob(storageKey);
  if (!job) return;
  bumpJob(job, priority);
  pump();
}

/** Drop queued ensures (route/server change) — in-flight jobs finish on their own. */
export function coverEnsureCancelPending(): void {
  const dropped = queue;
  queue = [];
  for (const job of dropped) {
    job.resolve({ hit: false, path: '' });
    ensureInflight.delete(job.storageKey);
  }
}

/** Cell unmounted or deferred — drop pending work so the viewport can jump the queue. */
export function coverEnsureRelease(storageKey: string): void {
  const idx = queue.findIndex(j => j.storageKey === storageKey);
  if (idx >= 0) {
    const [job] = queue.splice(idx, 1);
    job.resolve({ hit: false, path: '' });
    ensureInflight.delete(storageKey);
  } else if (!inflightStorageKeys.has(storageKey)) {
    ensureInflight.delete(storageKey);
  }
}

/** Queued + active ensure jobs (for library backfill watermark). */
export function coverEnsureQueueBacklog(): number {
  return queue.length + inflight;
}

/** @internal Vitest-only — module singleton queue. */
export function __test_resetCoverEnsureQueue(): void {
  queue = [];
  inflight = 0;
  nextOrderKey = 0;
  inflightStorageKeys.clear();
  ensureInflight.clear();
  coverDownloadTail.clear();
}

/** @internal Vitest-only — queued cover art IDs front-to-back. */
export function __test_queuedCoverIds(): string[] {
  return queue.map(j => j.ref.coverArtId);
}

function ensureMemoryHit(storageKey: string, ref: CoverArtRef, tier: CoverArtTier): boolean {
  if (getDiskSrc(storageKey)) return true;
  return Boolean(getDiskSrcForGrid(ref.serverScope, ref.coverArtId, tier));
}

/** Rust disk ensure — parallel slots; one download chain per cover art ID. */
export function coverEnsureQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
  priority: CoverPrefetchPriority,
): Promise<{ hit: boolean; path: string }> {
  if (ensureMemoryHit(storageKey, ref, tier)) {
    return Promise.resolve({ hit: true, path: '' });
  }

  const existing = ensureInflight.get(storageKey);
  if (existing) {
    const queued = findQueuedJob(storageKey);
    if (queued) bumpJob(queued, priority);
    return existing;
  }

  const p = new Promise<{ hit: boolean; path: string }>(resolve => {
    const orderKey = ++nextOrderKey;
    const prev = findQueuedJob(storageKey);
    if (prev) {
      bumpJob(prev, priority);
      const chain = prev.resolve;
      prev.resolve = r => {
        chain(r);
        resolve(r);
      };
      trimQueue();
      pump();
      return;
    }
    queue.push({ storageKey, ref, tier, priority, orderKey, resolve });
    sortQueue();
    trimQueue();
    pump();
  }).finally(() => ensureInflight.delete(storageKey));

  ensureInflight.set(storageKey, p);
  return p;
}
