import type { TFunction } from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { computeSyncPaths, deleteDeviceFiles, syncBatchToDevice } from '@/lib/api/syncfs';
import { buildDownloadUrl } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useDeviceSyncStore, type DeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import { useDeviceSyncJobStore } from '@/features/deviceSync/store/deviceSyncJobStore';
import { showToast } from '@/lib/dom/toast';
import { trackToSyncInfo, uuid } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { fetchTracksForSource } from '@/features/playback/utils/playback/fetchTracksForSource';

export interface SyncDelta {
  addBytes: number;
  addCount: number;
  delBytes: number;
  delCount: number;
  availableBytes: number;
  tracks: SubsonicSong[];
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
    const { getClient } = await import('@/lib/api/subsonicClient');
    const { baseUrl, params } = getClient();
    const payload = await invoke<SyncDelta>('calculate_sync_payload', {
      sources,
      deletionIds: pendingDeletion,
      auth: { baseUrl, ...params },
      targetDir,
    });

    setSyncDelta(payload);
  } catch {
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    setPreSyncOpen(false);
  } finally {
    setPreSyncLoading(false);
  }
}

export interface RunDeviceSyncExecuteDeps {
  targetDir: string | null;
  sources: DeviceSyncSource[];
  pendingDeletion: string[];
  syncDelta: SyncDelta;
  t: TFunction;
  setPreSyncOpen: (v: boolean) => void;
  removeSources: (ids: string[]) => void;
  scanDevice: () => Promise<void>;
}

export async function runDeviceSyncExecute(deps: RunDeviceSyncExecuteDeps): Promise<void> {
  const { targetDir, sources, pendingDeletion, syncDelta, t, setPreSyncOpen, removeSources, scanDevice } = deps;
  if (!targetDir) return;

  setPreSyncOpen(false);

  // 1. Handle pending deletions first
  const deletionSources = sources.filter(s => pendingDeletion.includes(s.id));
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
            source.type === 'playlist' ? { name: source.name, index: idx + 1 } : undefined,
          )),
          destDir: targetDir,
        });
        allPaths.push(...paths);
      }

      await deleteDeviceFiles({ paths: allPaths });
      removeSources(deletionSources.map(s => s.id));
      // Update manifest so it stays in sync after deletions
      const remainingSources = useDeviceSyncStore.getState().sources;
      if (targetDir) invoke('write_device_manifest', { destDir: targetDir, sources: remainingSources }).catch(() => {});
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
      const playlistSources = sources.filter(s => s.type === 'playlist');
      playlistSources.forEach(async playlist => {
        try {
          const tracks = await fetchTracksForSource(playlist);
          await invoke('write_playlist_m3u8', {
            destDir: targetDir,
            playlistName: playlist.name,
            tracks: tracks.map((tr, idx) => trackToSyncInfo(tr, '', { name: playlist.name, index: idx + 1 })),
          });
        } catch { /* non-fatal */ }
      });
    }
    scanDevice();
    return;
  }

  const jobId = uuid();
  useDeviceSyncJobStore.getState().startSync(jobId, allTracks.length);

  showToast(t('deviceSync.syncInBackground'), 3000, 'info');

  syncBatchToDevice({
    tracks: allTracks.map(track => trackToSyncInfo(track, buildDownloadUrl(track.id))),
    destDir: targetDir,
    jobId,
    expectedBytes: syncDelta.addBytes,
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
