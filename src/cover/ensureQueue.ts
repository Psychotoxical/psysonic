import { coverCacheEnsure, type CoverEnsureOpts } from '@/lib/api/coverCache';
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
  /** External-artwork ensure context (fanart/banner surfaces); undefined for plain covers. */
  opts?: CoverEnsureOpts;
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
/** Abort wedged Rust ensures so invoke slots cannot stall the grid forever. */
const ENSURE_INVOKE_TIMEOUT_MS = 45_000;

let inflight = 0;
let queue: EnsureJob[] = [];
let nextOrderKey = 0;
const inflightStorageKeys = new Set<string>();
const backlogDrainListeners = new Set<() => void>();

type EnsureInvokeResult = { hit: boolean; path: string };

function coverInflightKey(ref: CoverArtRef, surfaceKind?: string): string {
  const base = `${coverIndexKeyFromRef(ref)}:${ref.cacheKind}:${ref.cacheEntityId}`;
  // External surfaces (fanart/banner) are distinct downloads for the same artist
  // id, so they must not share one in-flight chain. Plain covers append nothing,
  // keeping every existing key byte-identical.
  return surfaceKind ? `${base}:${surfaceKind}` : base;
}

/** One active Rust ensure per cover art id — waiters attach without consuming invoke slots. */
const coverArtInFlight = new Map<string, Promise<EnsureInvokeResult>>();

function withEnsureTimeout(
  promise: Promise<EnsureInvokeResult>,
): Promise<EnsureInvokeResult> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('cover ensure invoke timeout'));
    }, ENSURE_INVOKE_TIMEOUT_MS);
    void promise.then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      error => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function invokeEnsureForCover(
  ref: CoverArtRef,
  tier: CoverArtTier,
  priority: CoverPrefetchPriority,
  opts?: CoverEnsureOpts,
): Promise<EnsureInvokeResult> {
  const key = coverInflightKey(ref, opts?.surfaceKind);
  const existing = coverArtInFlight.get(key);
  if (existing) return existing;

  const flight = withEnsureTimeout(
    coverCacheEnsure(ref, tier, priority, opts).then(r => ({ hit: r.hit, path: r.path })),
  ).finally(() => {
    if (coverArtInFlight.get(key) === flight) coverArtInFlight.delete(key);
  });
  coverArtInFlight.set(key, flight);
  return flight;
}

function settleJob(job: EnsureJob, result: EnsureInvokeResult): void {
  job.resolve(result);
}

function attachQueuedJobsToActiveFlights(): void {
  let i = 0;
  while (i < queue.length) {
    const job = queue[i]!;
    const flight = coverArtInFlight.get(coverInflightKey(job.ref, job.opts?.surfaceKind));
    if (!flight) {
      i += 1;
      continue;
    }
    queue.splice(i, 1);
    void flight
      .then(r => settleJob(job, r))
      .catch(() => settleJob(job, { hit: false, path: '' }));
  }
}

function notifyBacklogDrain(): void {
  for (const listener of backlogDrainListeners) {
    listener();
  }
}

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
    let worstIdx = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const job = queue[i]!;
      if (job.priority === 'high') continue;
      if (worstIdx < 0) {
        worstIdx = i;
        continue;
      }
      const worst = queue[worstIdx]!;
      const rank = priorityRank(job.priority);
      const worstRank = priorityRank(worst.priority);
      if (rank > worstRank || (rank === worstRank && job.orderKey < worst.orderKey)) {
        worstIdx = i;
      }
    }
    if (worstIdx < 0) break;
    const [job] = queue.splice(worstIdx, 1);
    job.resolve({ hit: false, path: '' });
    ensureInflight.delete(job.storageKey);
  }
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
  attachQueuedJobsToActiveFlights();

  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    let pickIdx = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i]!;
      if (coverTrafficBackgroundPaused() && candidate.priority !== 'high') {
        break;
      }
      if (coverArtInFlight.has(coverInflightKey(candidate.ref, candidate.opts?.surfaceKind))) continue;
      pickIdx = i;
      break;
    }
    if (pickIdx < 0) break;

    const job = queue.splice(pickIdx, 1)[0]!;
    inflight += 1;
    inflightStorageKeys.add(job.storageKey);
    void invokeEnsureForCover(job.ref, job.tier, job.priority, job.opts)
      .then(r => settleJob(job, r))
      .catch(() => settleJob(job, { hit: false, path: '' }))
      .finally(() => {
        inflight -= 1;
        inflightStorageKeys.delete(job.storageKey);
        pump();
        notifyBacklogDrain();
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

/** Set queued priority (upgrade or downgrade) and bump order for LIFO within the tier. */
export function coverEnsureReprioritize(
  storageKey: string,
  priority: CoverPrefetchPriority,
): void {
  const job = findQueuedJob(storageKey);
  if (!job) return;
  job.priority = priority;
  job.orderKey = ++nextOrderKey;
  sortQueue();
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

/** Resume ensure pump after a grid-pagination hold ends. */
export function coverEnsureResumePump(): void {
  pump();
  notifyBacklogDrain();
}

/** Retry pagination / prefetch when the ensure backlog drops (sentinel may still be visible). */
export function coverEnsureSubscribeBacklogDrain(listener: () => void): () => void {
  backlogDrainListeners.add(listener);
  return () => {
    backlogDrainListeners.delete(listener);
  };
}

/** Queued + active ensure jobs (for library backfill watermark). */
export function coverEnsureQueueBacklog(): number {
  return queue.length + inflight;
}

export type CoverEnsureQueueStats = {
  queuedHigh: number;
  queuedMiddle: number;
  queuedLow: number;
  inflight: number;
  maxInflight: number;
};

/** Webview ensure queue — tier breakdown for perf probe overlay. */
export function coverEnsureQueueStats(): CoverEnsureQueueStats {
  let queuedHigh = 0;
  let queuedMiddle = 0;
  let queuedLow = 0;
  for (const job of queue) {
    if (job.priority === 'high') queuedHigh += 1;
    else if (job.priority === 'middle') queuedMiddle += 1;
    else queuedLow += 1;
  }
  return {
    queuedHigh,
    queuedMiddle,
    queuedLow,
    inflight,
    maxInflight: MAX_INFLIGHT,
  };
}

/** @internal Vitest-only — module singleton queue. */
export function __test_resetCoverEnsureQueue(): void {
  queue = [];
  inflight = 0;
  nextOrderKey = 0;
  inflightStorageKeys.clear();
  ensureInflight.clear();
  coverArtInFlight.clear();
  backlogDrainListeners.clear();
}

/** @internal Vitest-only — queued cover art IDs front-to-back. */
export function __test_queuedCoverIds(): string[] {
  return queue.map(j => j.ref.cacheEntityId);
}

function ensureMemoryHit(storageKey: string, ref: CoverArtRef, tier: CoverArtTier): boolean {
  if (getDiskSrc(storageKey)) return true;
  return Boolean(getDiskSrcForGrid(ref, tier));
}

/** Rust disk ensure — parallel slots; one download chain per cover art ID. */
export function coverEnsureQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
  priority: CoverPrefetchPriority,
  opts?: CoverEnsureOpts,
): Promise<{ hit: boolean; path: string }> {
  // External surfaces (fanart/banner) bypass the disk-src memory short-circuit:
  // their `{tier}-{surface}.webp` never seeds those caches, and the artist's
  // canonical cover sitting in the grid cache must not be mistaken for a hit.
  if (!opts?.surfaceKind && ensureMemoryHit(storageKey, ref, tier)) {
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
    queue.push({ storageKey, ref, tier, priority, orderKey, opts, resolve });
    sortQueue();
    trimQueue();
    pump();
  }).finally(() => ensureInflight.delete(storageKey));

  ensureInflight.set(storageKey, p);
  return p;
}

/**
 * Queue an external artist-backdrop ensure (fanart/banner surface) at a given
 * priority, reusing the same dedupe / reprioritise / memory-pressure trim as
 * grid covers. The surface is woven into the storage + in-flight keys so the
 * two surfaces of one artist do not collide. Always tier 2000 (external
 * surfaces are 2000-only). Resolves `{ hit, path }`; `path` is the on-disk
 * `{2000}-{surface}.webp` to hand to `coverDiskUrl`.
 */
export function ensureArtistBackdropQueued(
  storageKey: string,
  ref: CoverArtRef,
  surface: 'fanart' | 'banner',
  priority: CoverPrefetchPriority,
  ctx?: { artistName?: string; albumTitle?: string },
): Promise<{ hit: boolean; path: string }> {
  return coverEnsureQueued(storageKey, ref, 2000, priority, {
    surfaceKind: surface,
    artistName: ctx?.artistName,
    albumTitle: ctx?.albumTitle,
  });
}
