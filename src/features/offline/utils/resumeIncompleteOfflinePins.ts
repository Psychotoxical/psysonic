import { libraryGetTracksBatchChunked } from '@/lib/api/library';
import { getPlaylist } from '@/lib/api/subsonicPlaylists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import type { OfflineAlbumMeta } from '@/features/offline/store/offlineStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { trackToSong } from '@/lib/library/advancedSearchLocal';
import { isActiveServerReachable, onActiveServerBecameReachable } from '@/lib/network/activeServerReachability';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { isOfflinePinComplete } from '@/features/offline/utils/offlineLibraryHelpers';
import { resolveAlbumForServer } from '@/features/offline/utils/offlineMediaResolve';

const DEBOUNCE_MS = 800;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function songsForOfflineMeta(
  meta: OfflineAlbumMeta,
  profileServerId: string,
): Promise<SubsonicSong[]> {
  if (meta.type === 'playlist' && shouldAttemptSubsonicForServer(profileServerId)) {
    const activeId = useAuthStore.getState().activeServerId;
    if (activeId === profileServerId) {
      try {
        const { songs } = await getPlaylist(meta.id);
        if (songs.length > 0) return songs;
      } catch {
        /* fall through */
      }
    }
  } else if (meta.type !== 'playlist') {
    try {
      const resolved = await resolveAlbumForServer(profileServerId, meta.id);
      if (resolved?.songs.length) return resolved.songs;
    } catch {
      /* fall through */
    }
  }

  const refs = meta.trackIds.map(trackId => ({ serverId: profileServerId, trackId }));
  const dtos = await libraryGetTracksBatchChunked(refs).catch(() => []);
  return dtos.map(trackToSong);
}

/**
 * Re-queue library-tier pins that still lack on-disk bytes (e.g. user left the
 * album page mid-download, or the app restarted while jobs were in memory only).
 */
export async function resumeIncompleteOfflinePins(): Promise<void> {
  if (!isActiveServerReachable()) return;

  const offline = useOfflineStore.getState();
  const metas = Object.values(offline.albums);

  for (const meta of metas) {
    if (!meta.trackIds?.length) continue;
    const profileServerId = resolveServerIdForIndexKey(meta.serverId) || meta.serverId;
    if (offline.isAlbumDownloading(meta.id)) continue;
    if (isOfflinePinComplete(meta.id, profileServerId, meta.trackIds)) continue;

    const songs = await songsForOfflineMeta(meta, profileServerId);
    if (songs.length === 0) continue;

    void offline.downloadAlbum(
      meta.id,
      meta.name,
      meta.artist,
      meta.coverArt,
      meta.year,
      songs,
      profileServerId,
      meta.type ?? 'album',
    );
  }
}

export function scheduleResumeIncompleteOfflinePins(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void resumeIncompleteOfflinePins();
  }, DEBOUNCE_MS);
}

/** App start, server switch, and reconnect → finish interrupted offline pins. */
export function initResumeIncompleteOfflinePins(): () => void {
  scheduleResumeIncompleteOfflinePins();
  const stopReachable = onActiveServerBecameReachable(() => scheduleResumeIncompleteOfflinePins());
  const stopAuth = useAuthStore.subscribe((state, prev) => {
    if (state.activeServerId !== prev.activeServerId) {
      scheduleResumeIncompleteOfflinePins();
    }
  });
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    stopReachable();
    stopAuth();
  };
}
