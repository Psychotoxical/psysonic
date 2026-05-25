import { coverCacheEnsure } from '../api/coverCache';
import { coverIndexKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority } from './types';

type EnsureJob = {
  ref: CoverArtRef;
  tier: CoverArtTier;
  priority: CoverPrefetchPriority;
  resolve: (r: { hit: boolean; path: string }) => void;
};

/** Parallel Rust cover ensures (library backfill + visible UI share this pool). */
export const COVER_ENSURE_MAX_INFLIGHT = 10;
const MAX_INFLIGHT = COVER_ENSURE_MAX_INFLIGHT;
let inflight = 0;
const queue: EnsureJob[] = [];

function priorityRank(p: CoverPrefetchPriority): number {
  return p === 'high' ? 0 : p === 'middle' ? 1 : 2;
}

function sortQueue(): void {
  queue.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
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

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const job = queue.shift()!;
    inflight += 1;
    void ensureForCover(job.ref, job.tier, job.priority)
      .then(r => job.resolve({ hit: r.hit, path: r.path }))
      .catch(() => job.resolve({ hit: false, path: '' }))
      .finally(() => {
        inflight -= 1;
        pump();
      });
  }
}

const ensureInflight = new Map<string, Promise<{ hit: boolean; path: string }>>();

/** Queued + active ensure jobs (for library backfill watermark). */
export function coverEnsureQueueBacklog(): number {
  return queue.length + inflight;
}

/** Rust disk ensure — parallel slots; one download chain per cover art ID. */
export function coverEnsureQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
  priority: CoverPrefetchPriority,
): Promise<{ hit: boolean; path: string }> {
  const existing = ensureInflight.get(storageKey);
  if (existing) return existing;

  const p = new Promise<{ hit: boolean; path: string }>(resolve => {
    queue.push({ ref, tier, priority, resolve });
    sortQueue();
    pump();
  }).finally(() => ensureInflight.delete(storageKey));

  ensureInflight.set(storageKey, p);
  return p;
}
