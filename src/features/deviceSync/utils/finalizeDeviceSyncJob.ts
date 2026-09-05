import { deleteDeviceFiles, writePlaylistM3u8 } from '@/lib/api/syncfs';
import { useDeviceSyncStore } from '@/features/deviceSync/store/deviceSyncStore';
import type { DeviceSyncJobContext } from '@/features/deviceSync/store/deviceSyncJobStore';
import { trackToSyncInfo } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

export async function finalizeDeviceSyncJob(context: DeviceSyncJobContext): Promise<void> {
  await Promise.all(context.playlists.map(playlist => writePlaylistM3u8({
    destDir: context.targetDir,
    playlistName: playlist.name,
    playlistId: playlist.pathId ?? null,
    tracks: playlist.tracks.map(track => trackToSyncInfo(track, '')),
    references: playlist.references,
  })));

  if (context.deferredDeletePaths.length > 0) {
    await deleteDeviceFiles({ destDir: context.targetDir, paths: context.deferredDeletePaths });
  }

  await writeDeviceSyncManifest({
    destDir: context.targetDir,
    ownerServerIndexKey: context.serverIndexKey,
    sources: context.sources,
    layoutMode: context.layoutMode,
    playlistPathMode: context.playlistPathMode,
    files: context.manifestFiles,
    playlists: context.manifestPlaylists,
  });

  const store = useDeviceSyncStore.getState();
  if (store.targetDir === context.targetDir) {
    store.removeSources(context.deletionSourceKeys);
    store.markConfigurationSynced(context.layoutMode, context.playlistPathMode);
  }
}
