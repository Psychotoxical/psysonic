import { parseLocalPlaybackEntryKey } from '@/store/localPlaybackKeys';
import { getMediaDir } from '@/lib/media/mediaDir';
import {
  evictEphemeralCacheOrphansToFit,
  getMediaTierSize,
  probeMediaFiles,
  pruneEmptyMediaTierDirs,
} from '@/lib/api/syncfs';

export interface EphemeralReconcileResult {
  removedStaleIndex: number;
}

/**
 * Injected local-playback state so this lib-floor module never imports the
 * `@/store/localPlaybackStore` value (which would form a runtime cycle:
 * store → ephemeralTierReconcile → store). The caller — always the store or a
 * store-aware module — passes its own `entries` + `removeEntry`.
 */
export interface EphemeralReconcileDeps {
  entries: Record<string, { tier: string; localPath: string }>;
  removeEntry: (trackId: string, serverIndexKey: string, reason?: string) => void;
}

/** On-disk byte total under `{media}/cache/` (all instances sharing the media dir). */
export async function getEphemeralDiskBytes(mediaDir: string | null): Promise<number> {
  return getMediaTierSize({ tier: 'ephemeral', mediaDir }).catch(() => 0);
}

/**
 * Delete cache files not in `keepPaths`, oldest mtime first, until tier size ≤ `maxBytes`.
 * Used when dev/prod share one media dir and another instance's bytes are not in this index.
 */
export async function evictEphemeralOrphansToFit(
  maxBytes: number,
  mediaDir: string | null,
  keepPaths: string[],
): Promise<string[]> {
  return evictEphemeralCacheOrphansToFit({ keepPaths, maxBytes, mediaDir }).catch(() => []);
}

/**
 * Index↔disk sync without evicting unindexed files (safe when dev + prod share `media/cache/`):
 * - drop index rows whose files are gone
 * - prune empty directories under `{media}/cache/`
 *
 * Unindexed on-disk files are removed only from `evictEphemeralToFit` when over budget.
 */
export async function reconcileEphemeralCache(
  deps: EphemeralReconcileDeps,
): Promise<EphemeralReconcileResult> {
  const mediaDir = getMediaDir();
  const ephemeral = Object.entries(deps.entries).filter(([, e]) => e.tier === 'ephemeral');

  const paths = ephemeral.map(([, e]) => e.localPath);
  const existsFlags =
    paths.length > 0
      ? await probeMediaFiles({ localPaths: paths }).catch(() => paths.map(() => false))
      : [];

  let removedStaleIndex = 0;

  ephemeral.forEach(([key, _entry], i) => {
    if (existsFlags[i]) {
      return;
    }
    const parsed = parseLocalPlaybackEntryKey(key);
    if (parsed) {
      deps.removeEntry(parsed.trackId, parsed.serverIndexKey, 'reconcile-missing-bytes');
      removedStaleIndex += 1;
    }
  });

  await pruneEmptyMediaTierDirs({ tier: 'ephemeral', mediaDir }).catch(() => {});

  return { removedStaleIndex };
}
