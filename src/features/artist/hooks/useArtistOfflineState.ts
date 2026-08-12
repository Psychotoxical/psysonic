import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { offlineAlbumIdsMatch, useOfflineJobStore } from '@/features/offline';
import { isOfflinePinComplete } from '@/features/offline';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

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
  const progressKey = ownedEntityKey({ id: artistId, serverId });
  const canonicalArtistId = canonicalizeConfirmedNavidromeId(serverId, artistId);
  const canonicalProgressKey = ownedEntityKey({ id: canonicalArtistId, serverId });
  const readBulkProgress = (bulkProgress: Record<string, { done: number; total: number }>) => {
    const direct = bulkProgress[canonicalProgressKey] ?? bulkProgress[progressKey];
    if (direct) return direct;
    const prefix = `${serverId}:`;
    return Object.entries(bulkProgress).find(([key]) => (
      key.startsWith(prefix)
      && canonicalizeConfirmedNavidromeId(serverId, key.slice(prefix.length)) === canonicalArtistId
    ))?.[1];
  };

  const allPinned = albumIds.length > 0
    && albumIds.every(id => isOfflinePinComplete(id, serverId));

  const bulkDone = useOfflineJobStore(s => (artistId
    ? readBulkProgress(s.bulkProgress)?.done
    : undefined));
  const bulkTotal = useOfflineJobStore(s => (artistId
    ? readBulkProgress(s.bulkProgress)?.total
    : undefined));
  const hasQueuedAlbums = useOfflineJobStore(s =>
    albumIds.length > 0
    && albumIds.some(id => s.pinQueue.some(
      p => offlineAlbumIdsMatch(id, p.albumId, p.serverId ?? serverId)
        && p.serverId === serverId && p.status === 'queued',
    )),
  );
  const hasDownloadingAlbums = useOfflineJobStore(s =>
    albumIds.length > 0
    && albumIds.some(id =>
      s.pinQueue.some(p => offlineAlbumIdsMatch(id, p.albumId, p.serverId ?? serverId)
        && p.serverId === serverId && p.status === 'downloading')
      || s.jobs.some(j => (
        offlineAlbumIdsMatch(id, j.albumId, j.serverId ?? serverId)
        && j.serverId === serverId
        && (j.status === 'queued' || j.status === 'downloading')
      )),
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
