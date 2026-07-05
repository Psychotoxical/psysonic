import { coverCacheMayBackgroundDownload as ipcMayDownload } from '@/lib/api/coverCache';
import { coverIndexKeyFromRef } from './storageKeys';
import { coverServerReachable } from './reachability';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority, CoverSurfaceKind } from './types';

const MAX_REGISTRY = 120;
const registry = new Map<string, { ref: CoverArtRef; priority: CoverPrefetchPriority }>();

function registryKey(ref: CoverArtRef): string {
  return `${coverIndexKeyFromRef(ref)}:${ref.cacheKind}:${ref.cacheEntityId}`;
}

export function coverPrefetchRegister(
  refs: CoverArtRef[],
  opts: {
    surface: CoverSurfaceKind;
    priority: CoverPrefetchPriority;
    deriveTiers?: CoverArtTier[];
  },
): () => void {
  if (opts.surface !== 'dense') return () => {};
  if (!coverCacheMayBackgroundDownload()) return () => {};

  const keys: string[] = [];
  for (const ref of refs) {
    if (!ref.cacheEntityId || !coverServerReachable(ref.serverScope)) continue;
    const key = registryKey(ref);
    if (registry.size >= MAX_REGISTRY && !registry.has(key)) {
      const drop = [...registry.entries()].find(([, v]) => v.priority === 'low');
      if (drop) registry.delete(drop[0]);
    }
    registry.set(key, { ref, priority: opts.priority });
    keys.push(key);
  }

  return () => {
    for (const key of keys) registry.delete(key);
  };
}

export function coverCacheMayBackgroundDownload(): boolean {
  return ipcMayDownload();
}

/** Drop all page-registered prefetch targets (route change). */
export function coverPrefetchClearRegistry(): void {
  registry.clear();
}

/** Drain registered IDs for background ensure (viewport / page batches). */
export function coverPrefetchDrainBatch(limit: number): CoverArtRef[] {
  const sorted = [...registry.entries()].sort((a, b) => {
    const rank = (p: CoverPrefetchPriority) =>
      p === 'high' ? 0 : p === 'middle' ? 1 : 2;
    return rank(a[1].priority) - rank(b[1].priority);
  });
  return sorted.slice(0, limit).map(([, v]) => v.ref);
}

/** Raise priority when a cover enters the viewport (e.g. horizontal album row). */
export function coverPrefetchBumpPriority(
  ref: CoverArtRef,
  priority: CoverPrefetchPriority,
): void {
  if (!ref.cacheEntityId || !coverServerReachable(ref.serverScope)) return;
  const key = registryKey(ref);
  const existing = registry.get(key);
  if (!existing) {
    registry.set(key, { ref, priority });
    return;
  }
  const rank = (p: CoverPrefetchPriority) =>
    p === 'high' ? 0 : p === 'middle' ? 1 : 2;
  if (rank(priority) < rank(existing.priority)) {
    registry.set(key, { ref, priority });
  }
}
