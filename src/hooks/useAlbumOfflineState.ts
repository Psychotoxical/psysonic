import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';

interface UseAlbumOfflineStateResult {
  resolvedOfflineStatus: 'none' | 'downloading' | 'cached';
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
 *  - If there's any queued / downloading job for this album, status is
 *    `downloading` and we expose a `{ done, total }` progress tuple.
 *  - Else we look at the persisted cache map: a fully-cached album is
 *    one where every trackId in the album-meta has a matching track entry.
 *  - Else `none`.
 *
 * `albumId` is allowed to be empty (e.g. while the page is still
 * fetching) — in that case every selector short-circuits to a benign
 * default.
 */
export function useAlbumOfflineState(albumId: string, serverId: string): UseAlbumOfflineStateResult {
  const offlineStatus = useOfflineStore((s): 'none' | 'downloading' | 'cached' => {
    if (!albumId) return 'none';
    const meta = s.albums[`${serverId}:${albumId}`];
    const isDownloaded = meta && meta.trackIds.length > 0 && meta.trackIds.every(tid => !!s.tracks[`${serverId}:${tid}`]);
    return isDownloaded ? 'cached' : 'none';
  });
  const isOfflineDownloading = useOfflineJobStore(s =>
    !!albumId && s.jobs.some(j => j.albumId === albumId && (j.status === 'queued' || j.status === 'downloading')),
  );
  const offlineProgressDone = useOfflineJobStore(s => {
    if (!albumId) return 0;
    return s.jobs.filter(j => j.albumId === albumId && (j.status === 'done' || j.status === 'error')).length;
  });
  const offlineProgressTotal = useOfflineJobStore(s => {
    if (!albumId) return 0;
    return s.jobs.filter(j => j.albumId === albumId).length;
  });
  const resolvedOfflineStatus = isOfflineDownloading ? 'downloading' : offlineStatus;
  const offlineProgress = offlineProgressTotal > 0
    ? { done: offlineProgressDone, total: offlineProgressTotal }
    : null;

  return { resolvedOfflineStatus, offlineProgress };
}
