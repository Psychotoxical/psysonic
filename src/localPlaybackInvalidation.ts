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

async function invalidateEntriesForLibraryServer(libraryServerId: string): Promise<void> {
  const store = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const targets = Object.values(store.entries).filter(
    e =>
      (e.tier === 'library' || e.tier === 'favorite-auto')
      && resolveServerIdForIndexKey(e.serverIndexKey) === libraryServerId,
  );

  for (const entry of targets) {
    const track = await libraryGetTrack(libraryServerId, entry.trackId).catch(() => null);
    if (!track) {
      await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
      store.removeEntry(entry.trackId, entry.serverIndexKey, 'sync-track-removed');
      continue;
    }
    if (!entry.layoutFingerprint) continue;
    const nextFp = layoutFingerprintFromLibraryTrack(track, entry.suffix);
    if (nextFp !== entry.layoutFingerprint) {
      await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
      store.removeEntry(entry.trackId, entry.serverIndexKey, 'sync-layout-changed');
    }
  }
}

function serverIndexKeyForLibraryId(libraryServerId: string): string | undefined {
  const server = useAuthStore.getState().servers.find(s => s.id === libraryServerId);
  if (!server) return undefined;
  return serverIndexKeyFromUrl(server.url) || server.id;
}

/** Drop stale local files after library sync; relocate legacy offline bytes when index is ready. */
export function initLocalPlaybackInvalidation(): () => void {
  let unlisten: (() => void) | null = null;
  void listen<{ serverId?: string }>('library:sync-idle', ({ payload }) => {
    const scopeId = payload?.serverId?.trim();
    if (!scopeId) return;
    void (async () => {
      const profileId = resolveServerIdForIndexKey(scopeId) || scopeId;
      const indexKey = serverIndexKeyForLibraryId(profileId);
      await runLegacyOfflineFileMigration(indexKey);
      await reconcileLibraryTierForServer(profileId);
      await invalidateEntriesForLibraryServer(profileId);
    })();
  }).then(fn => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
    unlisten = null;
  };
}
