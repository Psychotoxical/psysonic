import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TFunction } from 'i18next';
import { useDeviceSyncJobStore } from '@/features/deviceSync/store/deviceSyncJobStore';
import { useDeviceSyncStore } from '@/features/deviceSync/store/deviceSyncStore';
import { showToast } from '@/lib/dom/toast';
import { playlistPathId, trackToSyncInfo } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { fetchTracksForSource } from '@/features/playback/utils/playback/fetchTracksForSource';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

export function useDeviceSyncJobEvents(
  t: TFunction,
  scanDevice: () => Promise<void>,
): void {
  useEffect(() => {
    const jobStore = useDeviceSyncJobStore.getState;
    const unlistenProgress = listen<{
      jobId: string; done: number; skipped: number; failed: number; total: number;
    }>('device:sync:progress', ({ payload }) => {
      const current = jobStore();
      if (current.jobId && payload.jobId === current.jobId) {
        useDeviceSyncJobStore.getState().updateProgress(
          payload.done, payload.skipped, payload.failed
        );
      }
    });

    const unlistenComplete = listen<{
      jobId: string; done: number; skipped: number; failed: number; total: number; cancelled?: boolean;
    }>('device:sync:complete', ({ payload }) => {
      const current = jobStore();
      if (current.jobId && payload.jobId === current.jobId) {
        if (payload.cancelled) {
          useDeviceSyncJobStore.getState().complete(payload.done, payload.skipped, payload.failed);
          // status is already 'cancelled' from the button click; complete() would overwrite it — restore it
          useDeviceSyncJobStore.getState().cancel();
        } else {
          useDeviceSyncJobStore.getState().complete(payload.done, payload.skipped, payload.failed);
          showToast(
            t('deviceSync.syncResult', {
              done: payload.done, skipped: payload.skipped, total: payload.total
            }),
            5000, 'info'
          );
          // Write manifest so another machine can read the synced sources from the stick
          const context = current.context;
          if (context) {
            const { targetDir: dir, sources: srcs, serverIndexKey } = context;
            writeDeviceSyncManifest({
              destDir: dir,
              ownerServerIndexKey: serverIndexKey,
              sources: srcs,
            }).catch(() => {});
            // For every playlist source, write an Extended-M3U next to the
            // playlist-folder tracks. Context carries the playlist name +
            // per-track index so the filenames match the files we just synced.
            const playlistSources = srcs.filter(s => s.type === 'playlist');
            playlistSources.forEach(async playlist => {
              try {
                const tracks = await fetchTracksForSource(playlist);
                await invoke('write_playlist_m3u8', {
                  destDir: dir,
                  playlistName: playlist.name,
                  playlistId: playlistPathId(playlist, srcs),
                  tracks: tracks.map((tr, idx) => trackToSyncInfo(
                    tr,
                    '',
                    {
                      id: playlistPathId(playlist, srcs),
                      name: playlist.name,
                      index: idx + 1,
                    },
                  )),
                });
              } catch { /* m3u8 failure is non-fatal — skip silently */ }
            });
          }
        }
        // Re-scan the device after sync completes (cancelled or not)
        if (useDeviceSyncStore.getState().targetDir === current.context?.targetDir) {
          scanDevice();
        }
      }
    });

    return () => {
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
    };
  }, [t, scanDevice]);
}
