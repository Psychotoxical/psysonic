import { coverCachePeekBatch } from '../api/coverCache';
import { getDiskSrc } from './diskSrcCache';
import { getDiskSrcForGrid } from './diskSrcLookup';
import { coverTrafficServerSwitchPaused } from './coverTraffic';
import { rememberGridDiskSrc } from './diskSrcLookup';
import { diskCoverArtIdCandidates, type DiskCoverIdHints } from './diskPeekIds';
import { coverIndexKeyFromRef, coverStorageKey } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

function peekMemoryHit(storageKey: string, ref: CoverArtRef, tier: CoverArtTier): boolean {
  if (getDiskSrc(storageKey)) return true;
  return Boolean(getDiskSrcForGrid(ref.serverScope, ref.coverArtId, tier));
}

type PeekJob = {
  storageKey: string;
  ref: CoverArtRef;
  tier: CoverArtTier;
  diskIdHints?: DiskCoverIdHints;
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

  const peekItems: { serverIndexKey: string; coverArtId: string; tier: CoverArtTier }[] = [];
  const peekKeysByJob = new Map<string, string[]>();

  for (const job of needDisk) {
    const serverIndexKey = coverIndexKeyFromRef(job.ref);
    const ids = diskCoverArtIdCandidates(job.ref.coverArtId, job.diskIdHints);
    const keys: string[] = [];
    for (const coverArtId of ids) {
      peekItems.push({ serverIndexKey, coverArtId, tier: job.tier });
      keys.push(coverStorageKey(job.ref.serverScope, coverArtId, job.tier));
    }
    peekKeysByJob.set(job.storageKey, keys);
  }

  const hits = await coverCachePeekBatch(peekItems);

  for (const job of needDisk) {
    const keys = peekKeysByJob.get(job.storageKey) ?? [job.storageKey];
    let path = '';
    for (const key of keys) {
      if (hits[key]) {
        path = hits[key]!;
        break;
      }
    }
    const hit = Boolean(
      path
      && rememberGridDiskSrc(job.ref.serverScope, job.ref.coverArtId, job.tier, path),
    );
    job.resolve(hit);
    inflight.delete(job.storageKey);
  }
}

/** Disk-only peek batched per microtask — seeds `diskSrcCache` without `cover_cache_ensure`. */
export function coverPeekQueued(
  storageKey: string,
  ref: CoverArtRef,
  tier: CoverArtTier,
  diskIdHints?: DiskCoverIdHints,
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
    pending.set(storageKey, { storageKey, ref, tier, diskIdHints, resolve });
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
