import { coverCacheEnsure } from '../api/coverCache';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority } from './types';

type EnsureJob = {
  ref: CoverArtRef;
  tier: CoverArtTier;
  priority: CoverPrefetchPriority;
  resolve: (r: { hit: boolean; path: string }) => void;
};

const MAX_INFLIGHT = 4;
let inflight = 0;
const queue: EnsureJob[] = [];

function priorityRank(p: CoverPrefetchPriority): number {
  return p === 'high' ? 0 : p === 'middle' ? 1 : 2;
}

function sortQueue(): void {
  queue.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const job = queue.shift()!;
    inflight += 1;
    void coverCacheEnsure(job.ref, job.tier, job.priority)
      .then(r => job.resolve({ hit: r.hit, path: r.path }))
      .catch(() => job.resolve({ hit: false, path: '' }))
      .finally(() => {
        inflight -= 1;
        pump();
      });
  }
}

const ensureInflight = new Map<string, Promise<{ hit: boolean; path: string }>>();

/** Rust disk ensure — parallel cache hits; bounded downloads; high priority first. */
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
