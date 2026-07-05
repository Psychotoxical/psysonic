import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline';
import { isOfflinePinComplete } from '@/features/offline';

export type ArtistOfflineStatus = 'none' | 'queued' | 'downloading' | 'cached';

interface UseArtistOfflineStateResult {
  status: ArtistOfflineStatus;
  progress: { done: number; total: number } | null;
}

/**
 * Offline discography status for an artist page. Uses persisted library pins
 * (not ephemeral bulkProgress) so "Discography cached" survives navigation.
 */
export function useArtistOfflineState(
  artistId: string,
  serverId: string,
  albumIds: string[],
): UseArtistOfflineStateResult {
  useLocalPlaybackStore(s => s.entries);

  const allPinned = albumIds.length > 0
    && albumIds.every(id => isOfflinePinComplete(id, serverId));

  const bulkDone = useOfflineJobStore(s => (artistId ? s.bulkProgress[artistId]?.done : undefined));
  const bulkTotal = useOfflineJobStore(s => (artistId ? s.bulkProgress[artistId]?.total : undefined));
  const hasQueuedAlbums = useOfflineJobStore(s =>
    albumIds.length > 0
    && albumIds.some(id => s.pinQueue.some(p => p.albumId === id && p.status === 'queued')),
  );
  const hasDownloadingAlbums = useOfflineJobStore(s =>
    albumIds.length > 0
    && albumIds.some(id =>
      s.pinQueue.some(p => p.albumId === id && p.status === 'downloading')
      || s.jobs.some(j => j.albumId === id && (j.status === 'queued' || j.status === 'downloading')),
    ),
  );

  const bulkActive = bulkTotal !== undefined && bulkDone !== undefined && bulkDone < bulkTotal;
  const waitingInQueue = bulkActive && hasQueuedAlbums && !hasDownloadingAlbums;

  const status: ArtistOfflineStatus = allPinned
    ? 'cached'
    : hasDownloadingAlbums || (bulkActive && !waitingInQueue)
      ? 'downloading'
      : waitingInQueue
        ? 'queued'
        : 'none';

  const progress = bulkActive && bulkDone !== undefined && bulkTotal !== undefined
    ? { done: bulkDone, total: bulkTotal }
    : null;

  return { status, progress };
}
