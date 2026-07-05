import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline';
import { isOfflinePinComplete } from '@/features/offline';

export type AlbumOfflineStatus = 'none' | 'queued' | 'downloading' | 'cached';

interface UseAlbumOfflineStateResult {
  resolvedOfflineStatus: AlbumOfflineStatus;
  offlineProgress: { done: number; total: number } | null;
}

/**
 * Combined offline-cache status for an album. Splits the read across
 * three primitive Zustand selectors so the page only re-renders when
 * one of the resolved scalars (status / done count / total count)
 * actually flips — not on every `jobs` array mutation during batch
 * downloads (each track flip would otherwise trigger a full page render).
 *
 * Resolution rules:
 *  - Fully pinned → `cached`.
 *  - Active pin jobs or pin-queue `downloading` → `downloading` + progress.
 *  - Pin-queue `queued` (waiting behind another album) → `queued`.
 *  - Else `none`.
 *
 * `albumId` is allowed to be empty (e.g. while the page is still
 * fetching) — in that case every selector short-circuits to a benign
 * default.
 */
export function useAlbumOfflineState(
  albumId: string,
  serverId: string,
  songIds?: string[],
): UseAlbumOfflineStateResult {
  useLocalPlaybackStore(s => s.entries);
  const pinComplete = !!albumId && isOfflinePinComplete(albumId, serverId, songIds);
  const isPinQueued = useOfflineJobStore(s =>
    !pinComplete
    && !!albumId
    && s.pinQueue.some(p => p.albumId === albumId && p.status === 'queued'),
  );
  const isOfflineDownloading = useOfflineJobStore(s =>
    !pinComplete
    && !!albumId
    && (
      s.pinQueue.some(p => p.albumId === albumId && p.status === 'downloading')
      || s.jobs.some(j => j.albumId === albumId && (j.status === 'queued' || j.status === 'downloading'))
    ),
  );
  const offlineProgressDone = useOfflineJobStore(s => {
    if (!albumId || pinComplete) return 0;
    return s.jobs.filter(j => j.albumId === albumId && (j.status === 'done' || j.status === 'error')).length;
  });
  const offlineProgressTotal = useOfflineJobStore(s => {
    if (!albumId || pinComplete) return 0;
    return s.jobs.filter(j => j.albumId === albumId).length;
  });
  const resolvedOfflineStatus = pinComplete
    ? 'cached'
    : isOfflineDownloading
      ? 'downloading'
      : isPinQueued
        ? 'queued'
        : 'none';
  const offlineProgress = isOfflineDownloading && offlineProgressTotal > 0
    ? { done: offlineProgressDone, total: offlineProgressTotal }
    : null;

  return { resolvedOfflineStatus, offlineProgress };
}
