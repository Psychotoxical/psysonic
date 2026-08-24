import { listen } from '@tauri-apps/api/event';
import { libraryGetTrack } from '@/lib/api/library';
import { useAuthStore } from './store/authStore';
import { useLocalPlaybackStore } from './store/localPlaybackStore';
import { layoutFingerprintFromLibraryTrack } from '@/lib/media/mediaLayout';
import { getMediaDir } from '@/lib/media/mediaDir';
import { deleteMediaFile } from '@/lib/api/syncfs';
import { runLegacyOfflineFileMigration } from '@/features/offline/utils/legacyOfflineFileMigration';
import { reconcileLibraryTierForServer } from '@/features/offline/utils/libraryTierReconcile';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { runOfflineServerMaintenance } from '@/features/offline/utils/offlineOperationCoordinator';

async function invalidateEntriesForLibraryServer(
  libraryServerId: string,
  shouldContinue: () => boolean,
): Promise<void> {
  const serverIndexKey = serverIndexKeyForLibraryId(libraryServerId);
  if (!serverIndexKey) return;
  const mediaDir = getMediaDir();
  await runOfflineServerMaintenance(serverIndexKey, async () => {
    if (!shouldContinue()) return;
    const targets = Object.values(useLocalPlaybackStore.getState().entries).filter(
      e =>
        (e.tier === 'library' || e.tier === 'favorite-auto')
        && resolveServerIdForIndexKey(e.serverIndexKey) === libraryServerId,
    );

    for (const entry of targets) {
      if (!shouldContinue()) return;
      const track = await libraryGetTrack(libraryServerId, entry.trackId).catch(() => null);
      if (!shouldContinue()) return;
      const current = useLocalPlaybackStore.getState().getEntry(
        entry.trackId,
        entry.serverIndexKey,
      );
      if (
        current?.localPath !== entry.localPath
        || current.layoutFingerprint !== entry.layoutFingerprint
      ) continue;
      const reason = !track
        ? 'sync-track-removed'
        : entry.layoutFingerprint
          && layoutFingerprintFromLibraryTrack(track, entry.suffix) !== entry.layoutFingerprint
          ? 'sync-layout-changed'
          : null;
      if (!reason) continue;
      await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
      if (!shouldContinue()) return;
      const afterDelete = useLocalPlaybackStore.getState().getEntry(
        entry.trackId,
        entry.serverIndexKey,
      );
      if (
        afterDelete?.localPath === entry.localPath
        && afterDelete.layoutFingerprint === entry.layoutFingerprint
      ) {
        useLocalPlaybackStore.getState().removeEntry(
          entry.trackId,
          entry.serverIndexKey,
          reason,
        );
      }
    }
  });
}

function serverIndexKeyForLibraryId(libraryServerId: string): string | undefined {
  const server = useAuthStore.getState().servers.find(s => s.id === libraryServerId);
  if (!server) return undefined;
  return serverIndexKeyFromUrl(server.url) || server.id;
}

/** Drop stale local files after library sync; relocate legacy offline bytes when index is ready. */
export function initLocalPlaybackInvalidation(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<{ serverId?: string }>('library:sync-idle', ({ payload }) => {
    if (disposed) return;
    const scopeId = payload?.serverId?.trim();
    if (!scopeId) return;
    void (async () => {
      const profileId = resolveServerIdForIndexKey(scopeId) || scopeId;
      const indexKey = serverIndexKeyForLibraryId(profileId);
      await runLegacyOfflineFileMigration(indexKey, () => !disposed);
      if (disposed) return;
      await reconcileLibraryTierForServer(profileId, () => !disposed);
      if (disposed) return;
      await invalidateEntriesForLibraryServer(profileId, () => !disposed);
    })();
  }).then(fn => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
