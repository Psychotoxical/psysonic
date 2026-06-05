import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { libraryGetTrack } from './api/library';
import { useLocalPlaybackStore } from './store/localPlaybackStore';
import { layoutFingerprintFromLibraryTrack } from './utils/media/mediaLayout';
import { getMediaDir } from './utils/media/mediaDir';
import { resolveServerIdForIndexKey } from './utils/server/serverLookup';

async function invalidateEntriesForLibraryServer(libraryServerId: string): Promise<void> {
  const store = useLocalPlaybackStore.getState();
  const mediaDir = getMediaDir();
  const targets = Object.values(store.entries).filter(
    e => resolveServerIdForIndexKey(e.serverIndexKey) === libraryServerId,
  );

  for (const entry of targets) {
    const track = await libraryGetTrack(libraryServerId, entry.trackId).catch(() => null);
    if (!track) {
      await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
      store.removeEntry(entry.trackId, entry.serverIndexKey, 'sync-track-removed');
      continue;
    }
    if (!entry.layoutFingerprint) continue;
    const nextFp = layoutFingerprintFromLibraryTrack(track, entry.suffix);
    if (nextFp !== entry.layoutFingerprint) {
      await invoke('delete_media_file', { localPath: entry.localPath, mediaDir }).catch(() => {});
      store.removeEntry(entry.trackId, entry.serverIndexKey, 'sync-layout-changed');
    }
  }
}

/** Drop stale local files after library sync updates metadata or tombstones tracks. */
export function initLocalPlaybackInvalidation(): () => void {
  let unlisten: (() => void) | null = null;
  void listen<{ serverId?: string }>('library:sync-idle', ({ payload }) => {
    const libraryServerId = payload?.serverId?.trim();
    if (!libraryServerId) return;
    void invalidateEntriesForLibraryServer(libraryServerId);
  }).then(fn => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
    unlisten = null;
  };
}
