import type { TFunction } from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { computeSyncPaths, deleteDeviceFiles, syncBatchToDevice } from '@/lib/api/syncfs';
import { buildDownloadUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  useDeviceSyncStore,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import { useDeviceSyncJobStore, type DeviceSyncJobContext } from '@/features/deviceSync/store/deviceSyncJobStore';
import { showToast } from '@/lib/dom/toast';
import { playlistPathId, trackToSyncInfo, uuid } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { fetchTracksForSource } from '@/features/playback/utils/playback/fetchTracksForSource';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { getAuthParams, restBaseFromUrl } from '@/lib/api/subsonicClient';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

export interface SyncDelta {
  addBytes: number;
  addCount: number;
  delBytes: number;
  delCount: number;
  availableBytes: number;
  tracks: SubsonicSong[];
  context: (DeviceSyncJobContext & { pendingDeletion: string[] }) | null;
}

function deviceSyncAuth(serverIndexKey: string) {
  const server = findServerByIdOrIndexKey(serverIndexKey);
  if (!server) throw new Error(`Unknown device sync server: ${serverIndexKey}`);
  return {
    baseUrl: restBaseFromUrl(connectBaseUrlForServer(server)),
    ...getAuthParams(server.username, server.password),
    serverId: server.id,
    serverIndexKey,
  };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface RunDeviceSyncSummaryDeps {
  targetDir: string | null;
  sources: DeviceSyncSource[];
  pendingDeletion: string[];
  t: TFunction;
  setPreSyncLoading: (v: boolean) => void;
  setPreSyncOpen: (v: boolean) => void;
  setSyncDelta: (v: SyncDelta) => void;
}

export async function runDeviceSyncSummaryPrompt(deps: RunDeviceSyncSummaryDeps): Promise<void> {
  const { targetDir, sources, pendingDeletion, t, setPreSyncLoading, setPreSyncOpen, setSyncDelta } = deps;

  if (!targetDir)          { showToast(t('deviceSync.noTargetDir'), 3000, 'error'); return; }
  if (sources.length === 0){ showToast(t('deviceSync.noSources'),   3000, 'error'); return; }

  setPreSyncLoading(true);
  setPreSyncOpen(true);

  try {
    const serverIndexKey = deviceSyncOwnerKey(sources);
    if (!serverIndexKey) throw new Error('Device sync sources do not have one server owner');
    const sourceSnapshot = sources.map(source => ({ ...source }));
    const deletionSnapshot = [...pendingDeletion];
    const payload = await invoke<Omit<SyncDelta, 'context'>>('calculate_sync_payload', {
      sources: sourceSnapshot,
      deletionIds: deletionSnapshot,
      auth: deviceSyncAuth(serverIndexKey),
      targetDir,
    });
    const liveState = useDeviceSyncStore.getState();
    const sourceKeys = sourceSnapshot.map(deviceSyncSourceKey);
    if (
      liveState.targetDir !== targetDir ||
      !sameStrings(liveState.sources.map(deviceSyncSourceKey), sourceKeys) ||
      !sameStrings(liveState.pendingDeletion, deletionSnapshot)
    ) {
      setPreSyncOpen(false);
      return;
    }

    setSyncDelta({
      ...payload,
      context: {
        targetDir,
        serverIndexKey,
        sources: sourceSnapshot,
        pendingDeletion: deletionSnapshot,
      },
    });
  } catch {
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    setPreSyncOpen(false);
  } finally {
    setPreSyncLoading(false);
  }
}

export interface RunDeviceSyncExecuteDeps {
  syncDelta: SyncDelta;
  t: TFunction;
  setPreSyncOpen: (v: boolean) => void;
  removeSources: (ids: string[]) => void;
  scanDevice: () => Promise<void>;
}

export async function runDeviceSyncExecute(deps: RunDeviceSyncExecuteDeps): Promise<void> {
  const { syncDelta, t, setPreSyncOpen, removeSources, scanDevice } = deps;
  const { context } = syncDelta;
  if (!context) return;
  const { targetDir, sources, pendingDeletion, serverIndexKey } = context;
  const runtimeServer = findServerByIdOrIndexKey(serverIndexKey);
  if (!runtimeServer) {
    setPreSyncOpen(false);
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    return;
  }

  setPreSyncOpen(false);

  // 1. Handle pending deletions first
  const deletionSources = sources.filter(s => pendingDeletion.includes(deviceSyncSourceKey(s)));
  const remainingSources = sources.filter(s => !pendingDeletion.includes(deviceSyncSourceKey(s)));
  let resultingSources = sources;
  if (deletionSources.length > 0) {
    try {
      const allPaths: string[] = [];
      // Compute paths per source so playlist sources delete from their own
      // folder (Playlists/{Name}/…) rather than from the album tree.
      for (const source of deletionSources) {
        const tracks = await fetchTracksForSource(source);
        const paths = await computeSyncPaths({
          tracks: tracks.map((tr, idx) => trackToSyncInfo(
            tr, '',
            source.type === 'playlist' ? {
              id: playlistPathId(source, sources),
              name: source.name,
              index: idx + 1,
            } : undefined,
          )),
          destDir: targetDir,
        });
        allPaths.push(...paths);
      }

      await deleteDeviceFiles({ paths: allPaths });
      removeSources(deletionSources.map(deviceSyncSourceKey));
      resultingSources = remainingSources;
      // Update manifest so it stays in sync after deletions
      await writeDeviceSyncManifest({
        destDir: targetDir,
        ownerServerIndexKey: serverIndexKey,
        sources: remainingSources,
      });
      showToast(
        t('deviceSync.deleteComplete', { count: deletionSources.length }),
        3000, 'info'
      );
    } catch {
      showToast(t('deviceSync.fetchError'), 3000, 'error');
    }
  }

  const allTracks = syncDelta.tracks;
  if (allTracks.length === 0) {
    // No new downloads needed, but the user may still have added a
    // playlist source — (re)write its .m3u8 against the existing files.
    if (targetDir) {
      const playlistSources = resultingSources.filter(s => s.type === 'playlist');
      await Promise.all(playlistSources.map(async playlist => {
        try {
          const tracks = await fetchTracksForSource(playlist);
          await invoke('write_playlist_m3u8', {
            destDir: targetDir,
            playlistName: playlist.name,
            playlistId: playlistPathId(playlist, resultingSources),
            tracks: tracks.map((tr, idx) => trackToSyncInfo(
              tr,
              '',
              {
                id: playlistPathId(playlist, resultingSources),
                name: playlist.name,
                index: idx + 1,
              },
            )),
          });
        } catch { /* non-fatal */ }
      }));
      await writeDeviceSyncManifest({
        destDir: targetDir,
        ownerServerIndexKey: serverIndexKey,
        sources: resultingSources,
      });
    }
    await scanDevice();
    return;
  }

  const jobId = uuid();
  useDeviceSyncJobStore.getState().startSync(jobId, allTracks.length, {
    targetDir,
    serverIndexKey,
    sources: resultingSources,
  });

  showToast(t('deviceSync.syncInBackground'), 3000, 'info');

  syncBatchToDevice({
    tracks: allTracks.map(track => trackToSyncInfo(
      track,
      buildDownloadUrlForServer(runtimeServer.id, track.id),
    )),
    destDir: targetDir,
    jobId,
    expectedBytes: syncDelta.addBytes,
    serverId: runtimeServer.id,
  }).catch((err: unknown) => {
    // The typed facade rejects with an Error whose message is the raw Rust error
    // string (previously invoke rejected with the bare string).
    const msg = err instanceof Error ? err.message : String(err);
    useDeviceSyncJobStore.getState().complete(0, 0, allTracks.length);
    if (msg.includes('NOT_ENOUGH_SPACE')) {
      showToast(t('deviceSync.notEnoughSpace'), 5000, 'error');
    } else if (msg === 'NOT_MOUNTED_VOLUME') {
      showToast(t('deviceSync.notMountedVolume'), 5000, 'error');
    } else {
      showToast(t('deviceSync.fetchError'), 3000, 'error');
    }
  });
}
