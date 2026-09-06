import { useEffect, useMemo, useState } from 'react';
import { computeSyncPaths } from '@/lib/api/syncfs';
import { fetchTracksForSource } from '@/features/playback/utils/playback/fetchTracksForSource';
import {
  playlistPathId,
  trackToSyncInfo,
  type SyncStatus,
} from '@/features/deviceSync/utils/deviceSyncHelpers';
import {
  deviceSyncSourceKey,
  type DeviceSyncLayoutMode,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';

export interface DeviceSyncSourceStatusesResult {
  sourcePathsMap: Map<string, string[]>;
  sourceStatuses: Map<string, SyncStatus>;
}

export function useDeviceSyncSourceStatuses(
  targetDir: string | null,
  sources: DeviceSyncSource[],
  pendingDeletion: string[],
  deviceFilePaths: string[],
  layoutMode: DeviceSyncLayoutMode,
  configurationDirty: boolean,
): DeviceSyncSourceStatusesResult {
  // Map source IDs → computed device paths (for status derivation)
  const [sourcePathsMap, setSourcePathsMap] = useState<Map<string, string[]>>(new Map());

  // Compute expected paths for each source (for status comparison)
  useEffect(() => {
    if (!targetDir || sources.length === 0) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSourcePathsMap(new Map());
      return;
    }
    // Path schema is fixed in the Rust backend now — no template parameter.
    let cancelled = false;
    (async () => {
      const map = new Map<string, string[]>();
      const fetched = await Promise.all(sources.map(async source => {
        try {
          return { source, tracks: await fetchTracksForSource(source) };
        } catch {
          return { source, tracks: [] };
        }
      }));
      const preferredSharedTracks = new Map<string, (typeof fetched)[number]['tracks'][number]>();
      for (const entry of fetched.filter(entry => entry.source.type !== 'playlist')) {
        for (const track of entry.tracks) {
          if (!preferredSharedTracks.has(track.id)) preferredSharedTracks.set(track.id, track);
        }
      }
      for (const entry of fetched.filter(entry => entry.source.type === 'playlist')) {
        for (const track of entry.tracks) {
          if (!preferredSharedTracks.has(track.id)) preferredSharedTracks.set(track.id, track);
        }
      }
      await Promise.all(fetched.map(async ({ source, tracks }) => {
        if (cancelled) return;
        try {
          const pathTracks = layoutMode === 'shared-album-tree'
            ? tracks.map(track => preferredSharedTracks.get(track.id) ?? track)
            : tracks;
          const paths = await computeSyncPaths({
            tracks: pathTracks.map((tr, idx) => trackToSyncInfo(
              tr, '',
              source.type === 'playlist' && layoutMode === 'self-contained'
                ? {
                  id: playlistPathId(source, sources),
                  name: source.name,
                  index: idx + 1,
                }
                : undefined,
            )),
            destDir: targetDir,
          });
          map.set(deviceSyncSourceKey(source), paths);
        } catch {
          map.set(deviceSyncSourceKey(source), []);
        }
      }));
      if (!cancelled) setSourcePathsMap(map);
    })();
    return () => { cancelled = true; };
  }, [targetDir, sources, layoutMode]);

  // Derive sync status per source
  const sourceStatuses = useMemo(() => {
    const deviceSet = new Set(deviceFilePaths);
    const statuses = new Map<string, SyncStatus>();
    for (const source of sources) {
      const sourceKey = deviceSyncSourceKey(source);
      if (pendingDeletion.includes(sourceKey)) {
        statuses.set(sourceKey, 'deletion');
      } else if (source.type === 'playlist' && configurationDirty) {
        statuses.set(sourceKey, 'pending');
      } else {
        const paths = sourcePathsMap.get(sourceKey) ?? [];
        const allSynced = paths.length > 0 && paths.every(p => deviceSet.has(p));
        statuses.set(sourceKey, allSynced ? 'synced' : 'pending');
      }
    }
    return statuses;
  }, [sources, pendingDeletion, sourcePathsMap, deviceFilePaths, configurationDirty]);

  return { sourcePathsMap, sourceStatuses };
}
