import { invoke } from '@tauri-apps/api/core';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { parseLocalPlaybackEntryKey } from '../../store/localPlaybackKeys';
import { getMediaDir } from '../media/mediaDir';

export interface EphemeralReconcileResult {
  removedStaleIndex: number;
}

/** On-disk byte total under `{media}/cache/` (all instances sharing the media dir). */
export async function getEphemeralDiskBytes(mediaDir: string | null): Promise<number> {
  return invoke<number>('get_media_tier_size', { tier: 'ephemeral', mediaDir }).catch(() => 0);
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
  return invoke<string[]>('evict_ephemeral_cache_orphans_to_fit', {
    keepPaths,
    maxBytes,
    mediaDir,
  }).catch(() => []);
}

/**
 * Index↔disk sync without evicting unindexed files (safe when dev + prod share `media/cache/`):
 * - drop index rows whose files are gone
 * - prune empty directories under `{media}/cache/`
 *
 * Unindexed on-disk files are removed only from `evictEphemeralToFit` when over budget.
 */
export async function reconcileEphemeralCache(): Promise<EphemeralReconcileResult> {
  const lp = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const ephemeral = Object.entries(lp.entries).filter(([, e]) => e.tier === 'ephemeral');

  const paths = ephemeral.map(([, e]) => e.localPath);
  const existsFlags =
    paths.length > 0
      ? await invoke<boolean[]>('probe_media_files', { localPaths: paths }).catch(() =>
          paths.map(() => false),
        )
      : [];

  let removedStaleIndex = 0;

  ephemeral.forEach(([key, _entry], i) => {
    if (existsFlags[i]) {
      return;
    }
    const parsed = parseLocalPlaybackEntryKey(key);
    if (parsed) {
      lp.removeEntry(parsed.trackId, parsed.serverIndexKey, 'reconcile-missing-bytes');
      removedStaleIndex += 1;
    }
  });

  await invoke('prune_empty_media_tier_dirs', { tier: 'ephemeral', mediaDir }).catch(() => {});

  return { removedStaleIndex };
}
