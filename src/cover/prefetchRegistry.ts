import { coverCacheMayBackgroundDownload as ipcMayDownload } from '../api/coverCache';
import { coverServerReachable } from './reachability';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority, CoverSurfaceKind } from './types';

const registry = new Map<string, { ref: CoverArtRef; priority: CoverPrefetchPriority }>();

function registryKey(ref: CoverArtRef): string {
  const sid =
    ref.serverScope.kind === 'server'
      ? ref.serverScope.serverId
      : ref.serverScope.kind === 'playback'
        ? 'playback'
        : 'active';
  return `${sid}:${ref.coverArtId}`;
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
    if (!ref.coverArtId || !coverServerReachable(ref.serverScope)) continue;
    const key = registryKey(ref);
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

/** Drain registered IDs for background ensure (viewport / page batches). */
export function coverPrefetchDrainBatch(limit: number): CoverArtRef[] {
  const sorted = [...registry.entries()].sort((a, b) => {
    const rank = (p: CoverPrefetchPriority) =>
      p === 'high' ? 0 : p === 'middle' ? 1 : 2;
    return rank(a[1].priority) - rank(b[1].priority);
  });
  return sorted.slice(0, limit).map(([, v]) => v.ref);
}
