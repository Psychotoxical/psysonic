import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fetchTracksForSource } from '../utils/fetchTracksForSource';
import { trackToSyncInfo, type SyncStatus } from '../utils/deviceSyncHelpers';
import type { DeviceSyncSource } from '../store/deviceSyncStore';

export interface DeviceSyncSourceStatusesResult {
  sourcePathsMap: Map<string, string[]>;
  sourceStatuses: Map<string, SyncStatus>;
}

export function useDeviceSyncSourceStatuses(
  targetDir: string | null,
  sources: DeviceSyncSource[],
  pendingDeletion: string[],
  deviceFilePaths: string[],
): DeviceSyncSourceStatusesResult {
  // Map source IDs → computed device paths (for status derivation)
  const [sourcePathsMap, setSourcePathsMap] = useState<Map<string, string[]>>(new Map());

  // Compute expected paths for each source (for status comparison)
  useEffect(() => {
    if (!targetDir || sources.length === 0) {
      setSourcePathsMap(new Map());
      return;
    }
    // Path schema is fixed in the Rust backend now — no template parameter.
    let cancelled = false;
    (async () => {
      const map = new Map<string, string[]>();
      await Promise.all(sources.map(async source => {
        if (cancelled) return;
        try {
          const tracks = await fetchTracksForSource(source);
          const paths = await invoke<string[]>('compute_sync_paths', {
            tracks: tracks.map((tr, idx) => trackToSyncInfo(
              tr, '',
              source.type === 'playlist' ? { name: source.name, index: idx + 1 } : undefined,
            )),
            destDir: targetDir,
          });
          map.set(source.id, paths);
        } catch {
          map.set(source.id, []);
        }
      }));
      if (!cancelled) setSourcePathsMap(map);
    })();
    return () => { cancelled = true; };
  }, [targetDir, sources]);

  // Derive sync status per source
  const sourceStatuses = useMemo(() => {
    const deviceSet = new Set(deviceFilePaths);
    const statuses = new Map<string, SyncStatus>();
    for (const source of sources) {
      if (pendingDeletion.includes(source.id)) {
        statuses.set(source.id, 'deletion');
      } else {
        const paths = sourcePathsMap.get(source.id) ?? [];
        const allSynced = paths.length > 0 && paths.every(p => deviceSet.has(p));
        statuses.set(source.id, allSynced ? 'synced' : 'pending');
      }
    }
    return statuses;
  }, [sources, pendingDeletion, sourcePathsMap, deviceFilePaths]);

  return { sourcePathsMap, sourceStatuses };
}
