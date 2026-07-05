import { coverCachePeekBatch } from '@/lib/api/coverCache';
import { getDiskSrc } from './diskSrcCache';
import { getDiskSrcForGrid } from './diskSrcLookup';
import { coverTrafficServerSwitchPaused } from './coverTraffic';
import { rememberGridDiskSrc } from './diskSrcLookup';
import type { CoverArtRef, CoverArtTier } from './types';

function peekMemoryHit(storageKey: string, ref: CoverArtRef, tier: CoverArtTier): boolean {
  if (getDiskSrc(storageKey)) return true;
  return Boolean(getDiskSrcForGrid(ref, tier));
}

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
  if (coverTrafficServerSwitchPaused()) {
    coverPeekCancelPending();
    return;
  }
  const jobs = [...pending.values()];
  pending.clear();
  if (jobs.length === 0) return;

  const needDisk: PeekJob[] = [];
  for (const job of jobs) {
    if (peekMemoryHit(job.storageKey, job.ref, job.tier)) {
      job.resolve(true);
      inflight.delete(job.storageKey);
    } else {
      needDisk.push(job);
    }
  }
  if (needDisk.length === 0) return;

  const byTier = new Map<CoverArtTier, PeekJob[]>();
  for (const job of needDisk) {
    const list = byTier.get(job.tier) ?? [];
    list.push(job);
    byTier.set(job.tier, list);
  }

  for (const [tier, jobs] of byTier) {
    const hits = await coverCachePeekBatch(
      jobs.map(j => j.ref),
      tier,
    );
    for (const job of jobs) {
      const path = hits[job.storageKey] ?? '';
      const hit = Boolean(path && rememberGridDiskSrc(job.ref, job.tier, path));
      job.resolve(hit);
      inflight.delete(job.storageKey);
    }
  }
}

/** Disk-only peek batched per microtask — seeds `diskSrcCache` without `cover_cache_ensure`. */
export function coverPeekQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
): Promise<boolean> {
  if (peekMemoryHit(storageKey, ref, tier)) {
    return Promise.resolve(true);
  }

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

/** Drop batched peeks (server switch) — callers get `false`. */
export function coverPeekCancelPending(): void {
  const jobs = [...pending.values()];
  pending.clear();
  for (const job of jobs) {
    job.resolve(false);
    inflight.delete(job.storageKey);
  }
}

export type CoverPeekQueueStats = {
  pending: number;
  inflight: number;
};

/** Batched disk peek backlog — perf probe overlay. */
export function coverPeekQueueStats(): CoverPeekQueueStats {
  return { pending: pending.size, inflight: inflight.size };
}
