import { coverCachePeekBatch } from '../api/coverCache';
import { rememberDiskSrc } from './diskSrcCache';
import { coverIndexKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

type PeekJob = {
  storageKey: string;
  ref: CoverArtRef;
  tier: CoverArtTier;
  resolve: (hit: boolean) => void;
};

let flushScheduled = false;
const pending = new Map<string, PeekJob>();
const inflight = new Map<string, Promise<boolean>>();

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flush();
  });
}

async function flush(): Promise<void> {
  const jobs = [...pending.values()];
  pending.clear();
  if (jobs.length === 0) return;

  const hits = await coverCachePeekBatch(
    jobs.map(job => ({
      serverIndexKey: coverIndexKeyFromRef(job.ref),
      coverArtId: job.ref.coverArtId,
      tier: job.tier,
    })),
  );

  for (const job of jobs) {
    const path = hits[job.storageKey];
    const hit = Boolean(path && rememberDiskSrc(job.storageKey, path));
    job.resolve(hit);
    inflight.delete(job.storageKey);
  }
}

/** Disk-only peek batched per microtask — seeds `diskSrcCache` without `cover_cache_ensure`. */
export function coverPeekQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
): Promise<boolean> {
  const running = inflight.get(storageKey);
  if (running) return running;

  const p = new Promise<boolean>(resolve => {
    const prev = pending.get(storageKey);
    if (prev) {
      const chain = prev.resolve;
      prev.resolve = hit => {
        chain(hit);
        resolve(hit);
      };
      return;
    }
    pending.set(storageKey, { storageKey, ref, tier, resolve });
    scheduleFlush();
  }).finally(() => {
    if (inflight.get(storageKey) === p) inflight.delete(storageKey);
  });

  inflight.set(storageKey, p);
  return p;
}
