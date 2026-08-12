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
import type { LibrarySyncIdlePayload } from '@/lib/api/library';

let invalidationPauseDepth = 0;
let invalidationLifecycle = 0;
const invalidationRuns = new Set<Promise<void>>();

async function invalidateEntriesForLibraryServer(
  libraryServerId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const store = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const targets = Object.values(store.entries).filter(
    e =>
      (e.tier === 'library' || e.tier === 'favorite-auto')
      && resolveServerIdForIndexKey(e.serverIndexKey) === libraryServerId,
  );

  for (const entry of targets) {
    if (!isCurrent()) return;
    const track = await libraryGetTrack(libraryServerId, entry.trackId).catch(() => null);
    if (!isCurrent()) return;
    if (!track) {
      await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
      const current = store.getEntry(entry.trackId, entry.serverIndexKey);
      if (current?.localPath === entry.localPath) {
        store.removeEntry(current.trackId, current.serverIndexKey, 'sync-track-removed');
      }
      if (!isCurrent()) return;
      continue;
    }
    if (!entry.layoutFingerprint) continue;
    const nextFp = layoutFingerprintFromLibraryTrack(track, entry.suffix);
    if (nextFp !== entry.layoutFingerprint) {
      await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
      const current = store.getEntry(entry.trackId, entry.serverIndexKey);
      if (current?.localPath === entry.localPath) {
        store.removeEntry(current.trackId, current.serverIndexKey, 'sync-layout-changed');
      }
      if (!isCurrent()) return;
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
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<LibrarySyncIdlePayload>('library:sync-idle', ({ payload }) => {
    if (disposed || invalidationPauseDepth > 0 || !payload.ok) return;
    const scopeId = payload?.serverId?.trim();
    if (!scopeId) return;
    const lifecycle = invalidationLifecycle;
    const isCurrent = () => (
      !disposed
      && invalidationPauseDepth === 0
      && invalidationLifecycle === lifecycle
    );
    const run = (async () => {
      const profileId = resolveServerIdForIndexKey(scopeId) || scopeId;
      const indexKey = serverIndexKeyForLibraryId(profileId);
      await runLegacyOfflineFileMigration(indexKey);
      if (!isCurrent()) return;
      await reconcileLibraryTierForServer(profileId);
      if (!isCurrent()) return;
      await invalidateEntriesForLibraryServer(profileId, isCurrent);
    })();
    const tracked = run.catch(() => {});
    invalidationRuns.add(tracked);
    void tracked.finally(() => invalidationRuns.delete(tracked));
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

export async function pauseAndDrainLocalPlaybackInvalidation(): Promise<void> {
  invalidationPauseDepth += 1;
  if (invalidationPauseDepth > 1) return;
  invalidationLifecycle += 1;
  await Promise.allSettled([...invalidationRuns]);
}

export function resumeLocalPlaybackInvalidation(): void {
  if (invalidationPauseDepth === 0) return;
  invalidationPauseDepth -= 1;
}
