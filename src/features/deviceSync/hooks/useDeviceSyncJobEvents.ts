import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import i18n from '@/lib/i18n';
import { listDeviceDirFiles } from '@/lib/api/syncfs';
import { useDeviceSyncJobStore } from '@/features/deviceSync/store/deviceSyncJobStore';
import { useDeviceSyncStore } from '@/features/deviceSync/store/deviceSyncStore';
import { showToast } from '@/lib/dom/toast';
import { finalizeDeviceSyncJob } from '@/features/deviceSync/utils/finalizeDeviceSyncJob';

async function scanCompletedTarget(targetDir: string): Promise<void> {
  const store = useDeviceSyncStore.getState();
  if (store.targetDir !== targetDir) return;
  store.setScanning(true);
  try {
    const paths = await listDeviceDirFiles({ dir: targetDir });
    if (useDeviceSyncStore.getState().targetDir === targetDir) {
      useDeviceSyncStore.getState().setDeviceFilePaths(paths);
    }
  } catch {
    if (useDeviceSyncStore.getState().targetDir === targetDir) {
      useDeviceSyncStore.getState().setDeviceFilePaths([]);
    }
  } finally {
    if (useDeviceSyncStore.getState().targetDir === targetDir) {
      useDeviceSyncStore.getState().setScanning(false);
    }
  }
}

export function useDeviceSyncJobEvents(): void {
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
        const context = current.context;
        if (payload.cancelled) {
          useDeviceSyncJobStore.getState().completeCancelled(payload.done, payload.skipped, payload.failed);
        } else if (payload.failed > 0 || !context) {
          useDeviceSyncJobStore.getState().fail(payload.done, payload.skipped, payload.failed || 1);
          showToast(i18n.t('deviceSync.syncResult', {
            done: payload.done, skipped: payload.skipped, total: payload.total,
          }), 5000, 'info');
        } else {
          useDeviceSyncJobStore.getState().beginFinalizing();
          void (async () => {
            try {
              await finalizeDeviceSyncJob(context);
              useDeviceSyncJobStore.getState().complete(payload.done, payload.skipped, payload.failed);
              showToast(i18n.t('deviceSync.syncResult', {
                done: payload.done, skipped: payload.skipped, total: payload.total,
              }), 5000, 'info');
            } catch {
              useDeviceSyncJobStore.getState().fail(payload.done, payload.skipped, 1);
              showToast(i18n.t('deviceSync.fetchError'), 3000, 'error');
            } finally {
              if (useDeviceSyncStore.getState().targetDir === context.targetDir) {
                await scanCompletedTarget(context.targetDir);
              }
            }
          })();
          return;
        }
        // Re-scan the device after sync completes (cancelled or not)
        if (useDeviceSyncStore.getState().targetDir === context?.targetDir) {
          void scanCompletedTarget(context.targetDir);
        }
      }
    });

    return () => {
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
    };
  }, []);
}
