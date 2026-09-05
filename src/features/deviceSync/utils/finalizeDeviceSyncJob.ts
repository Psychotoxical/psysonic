import { finalizeDeviceSync } from '@/lib/api/syncfs';
import { useDeviceSyncStore } from '@/features/deviceSync/store/deviceSyncStore';
import type { DeviceSyncJobContext } from '@/features/deviceSync/store/deviceSyncJobStore';
import { trackToSyncInfo } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { prepareDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

export async function finalizeDeviceSyncJob(context: DeviceSyncJobContext): Promise<void> {
  useDeviceSyncStore.getState().setPendingPlan(true);
  useDeviceSyncStore.getState().setPendingPlanDeviceId(context.deviceId);
  const manifest = prepareDeviceSyncManifest({
    destDir: context.targetDir,
    ownerServerIndexKey: context.serverIndexKey,
    sources: context.sources,
    layoutMode: context.layoutMode,
    playlistPathMode: context.playlistPathMode,
    files: context.manifestFiles,
    playlists: context.manifestPlaylists,
  });
  const result = await finalizeDeviceSync({
    destDir: context.targetDir,
    payload: {
      planId: context.planId,
      expectedDeviceId: context.deviceId,
      ownerServerIndexKey: manifest.ownerServerIndexKey,
      sources: manifest.sources.map(source => ({
        ...source,
        pathId: source.pathId ?? null,
        artist: source.artist ?? null,
      })),
      canonicalIdVersion: manifest.canonicalIdVersion,
      layoutMode: context.layoutMode,
      playlistPathMode: context.playlistPathMode,
      files: context.manifestFiles,
      manifestPlaylists: context.manifestPlaylists,
      playlists: context.playlists.map(playlist => ({
        name: playlist.name,
        pathId: playlist.pathId ?? null,
        tracks: playlist.tracks.map(track => trackToSyncInfo(track, '')),
        references: playlist.references,
      })),
      deferredDeletePaths: context.deferredDeletePaths,
    },
  });
  if (result.cleanupFailed) throw new Error('DEVICE_SYNC_CLEANUP_FAILED');

  const store = useDeviceSyncStore.getState();
  if (store.targetDir === context.targetDir) {
    store.setPendingPlan(false);
    store.setPendingPlanDeviceId(null);
    store.setTargetDeviceId(context.deviceId);
    store.removeSources(context.deletionSourceKeys);
    store.markConfigurationSynced(context.layoutMode, context.playlistPathMode);
  }
}
