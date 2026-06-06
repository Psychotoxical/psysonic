import { invoke } from '@tauri-apps/api/core';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { parseLocalPlaybackEntryKey } from '../../store/localPlaybackKeys';
import { getMediaDir } from '../media/mediaDir';

export interface EphemeralReconcileResult {
  removedStaleIndex: number;
  orphansRemoved: number;
}

/**
 * Directory-first ephemeral cache maintenance:
 * - drop index rows whose files are gone
 * - delete on-disk bytes not referenced by the index (incl. `.part` orphans)
 * - prune empty directories under `{media}/cache/`
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

  const keepPaths: string[] = [];
  let removedStaleIndex = 0;

  ephemeral.forEach(([key, entry], i) => {
    if (existsFlags[i]) {
      keepPaths.push(entry.localPath);
      return;
    }
    const parsed = parseLocalPlaybackEntryKey(key);
    if (parsed) {
      lp.removeEntry(parsed.trackId, parsed.serverIndexKey, 'reconcile-missing-bytes');
      removedStaleIndex += 1;
    }
  });

  let orphansRemoved = 0;
  try {
    const removed = await invoke<string[]>('prune_orphan_ephemeral_cache_files', {
      keepPaths,
      mediaDir,
    });
    orphansRemoved = removed.length;
  } catch {
    orphansRemoved = 0;
  }

  await invoke('prune_empty_media_tier_dirs', { tier: 'ephemeral', mediaDir }).catch(() => {});

  return { removedStaleIndex, orphansRemoved };
}
