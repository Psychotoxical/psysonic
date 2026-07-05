import { useMemo } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useFavoritesOfflineSyncStore } from '@/features/offline';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline';
import { FAVORITES_OFFLINE_JOB_ID } from '@/features/offline';
import { entryBelongsToServer } from '@/store/localPlaybackResolve';

export type FavoritesOfflineUiStatus =
  | 'disabled'
  | 'syncing'
  | 'complete'
  | 'partial'
  | 'error'
  | 'idle';

export type FavoritesOfflineSemaphore = 'red' | 'yellow' | 'green';

export interface FavoritesOfflineStatusResult {
  enabled: boolean;
  status: FavoritesOfflineUiStatus;
  semaphore: FavoritesOfflineSemaphore | null;
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
        semaphore: null,
        savedCount: 0,
        targetCount: 0,
        jobDone: 0,
        jobTotal: 0,
      };
    }

    const favJobs = jobs.filter(j => j.albumId === FAVORITES_OFFLINE_JOB_ID);
    const jobDone = favJobs.filter(j => j.status === 'done').length;
    const jobTotal = favJobs.length;
    const hasActiveJobs = favJobs.some(j => j.status === 'downloading' || j.status === 'queued');
    const hasJobErrors = favJobs.some(j => j.status === 'error');

    const savedCount = serverId
      ? Object.values(entries).filter(
          e => e.tier === 'favorite-auto' && entryBelongsToServer(e, serverId),
        ).length
      : 0;

    const targetCount = targetTrackIds.length;

    let status: FavoritesOfflineUiStatus = 'idle';
    if (running || hasActiveJobs) {
      status = 'syncing';
    } else if (lastError || hasJobErrors) {
      status = 'error';
    } else if (targetCount > 0 && savedCount >= targetCount) {
      status = 'complete';
    } else if (savedCount > 0 && targetCount > 0 && savedCount < targetCount) {
      status = 'partial';
    } else if (savedCount > 0) {
      status = 'complete';
    }

    let semaphore: FavoritesOfflineSemaphore = 'green';
    if (lastError || hasJobErrors) {
      semaphore = 'red';
    } else if (running || hasActiveJobs || (targetCount > 0 && savedCount < targetCount)) {
      semaphore = 'yellow';
    }

    return { enabled, status, semaphore, savedCount, targetCount, jobDone, jobTotal };
  }, [enabled, serverId, entries, running, lastError, targetTrackIds, jobs]);
}
