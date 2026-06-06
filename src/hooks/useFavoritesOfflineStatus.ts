import { useMemo } from 'react';
import { useAuthStore } from '../store/authStore';
import { useFavoritesOfflineSyncStore } from '../store/favoritesOfflineSyncStore';
import { useLocalPlaybackStore } from '../store/localPlaybackStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { FAVORITES_OFFLINE_JOB_ID } from '../utils/offline/favoritesOfflineConstants';
import { entryBelongsToServer } from '../utils/offline/offlineLibraryHelpers';

export type FavoritesOfflineUiStatus =
  | 'disabled'
  | 'syncing'
  | 'complete'
  | 'partial'
  | 'error'
  | 'idle';

export interface FavoritesOfflineStatusResult {
  enabled: boolean;
  status: FavoritesOfflineUiStatus;
  savedCount: number;
  targetCount: number;
  jobDone: number;
  jobTotal: number;
}

export function useFavoritesOfflineStatus(): FavoritesOfflineStatusResult {
  const enabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const serverId = useAuthStore(s => s.activeServerId);
  const entries = useLocalPlaybackStore(s => s.entries);
  const running = useFavoritesOfflineSyncStore(s => s.running);
  const lastError = useFavoritesOfflineSyncStore(s => s.lastError);
  const targetTrackIds = useFavoritesOfflineSyncStore(s => s.targetTrackIds);
  const jobs = useOfflineJobStore(s => s.jobs);

  return useMemo(() => {
    if (!enabled) {
      return {
        enabled: false,
        status: 'disabled' as const,
        savedCount: 0,
        targetCount: 0,
        jobDone: 0,
        jobTotal: 0,
      };
    }

    const favJobs = jobs.filter(j => j.albumId === FAVORITES_OFFLINE_JOB_ID);
    const jobDone = favJobs.filter(j => j.status === 'done').length;
    const jobTotal = favJobs.length;

    const savedCount = serverId
      ? Object.values(entries).filter(
          e => e.tier === 'favorite-auto' && entryBelongsToServer(e, serverId),
        ).length
      : 0;

    const targetCount = targetTrackIds.length;

    let status: FavoritesOfflineUiStatus = 'idle';
    if (running || favJobs.some(j => j.status === 'downloading' || j.status === 'queued')) {
      status = 'syncing';
    } else if (lastError) {
      status = 'error';
    } else if (targetCount > 0 && savedCount >= targetCount) {
      status = 'complete';
    } else if (savedCount > 0 && targetCount > 0 && savedCount < targetCount) {
      status = 'partial';
    } else if (savedCount > 0) {
      status = 'complete';
    }

    return { enabled, status, savedCount, targetCount, jobDone, jobTotal };
  }, [enabled, serverId, entries, running, lastError, targetTrackIds, jobs]);
}
