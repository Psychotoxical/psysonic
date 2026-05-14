import { buildStreamUrl } from './api/subsonicStreamUrl';
import type { Track } from './store/playerStoreTypes';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from './store/authStore';
import { useHotCacheStore } from './store/hotCacheStore';
import { useOfflineStore } from './store/offlineStore';
import { usePlayerStore } from './store/playerStore';
import {
  bumpHotCachePreviousTrackGrace,
  clearHotCachePreviousGrace,
  getDeferHotCachePrefetch,
} from './utils/cache/hotCacheGate';
import {
  PREFETCH_AHEAD,
  type PrefetchJob,
  entryKey,
  sumCachedBytesInProtectedWindow,
  estimateTrackHotCacheBytes,
  hotCacheFrontendDebug,
  debounceMs,
} from './hotCachePrefetch/helpers';
import {
  scheduleAnalysisQueuePruneFromPlaybackQueue,
  resetAnalysisPruneState,
} from './hotCachePrefetch/analysisPrune';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Fires `replanNow` once grace for the ex-current track ends so eviction can drop it. */
let graceEvictTimer: ReturnType<typeof setTimeout> | null = null;
const pendingQueue: PrefetchJob[] = [];
let workerRunning = false;

function scheduleEvictAfterPreviousGrace(): void {
  if (graceEvictTimer) {
    clearTimeout(graceEvictTimer);
    graceEvictTimer = null;
  }
  const ms = debounceMs();
  if (ms <= 0) {
    void replanNow();
    return;
  }
  graceEvictTimer = setTimeout(() => {
    graceEvictTimer = null;
    void replanNow();
  }, ms);
}

function enqueueJobs(jobs: PrefetchJob[]) {
  const seen = new Set(pendingQueue.map(j => `${j.serverId}:${j.trackId}`));
  let merged = 0;
  for (const j of jobs) {
    const k = `${j.serverId}:${j.trackId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pendingQueue.push(j);
    merged++;
  }
  if (merged > 0) {
    hotCacheFrontendDebug({
      event: 'prefetch-queue-jobs',
      added: merged,
      pendingTotal: pendingQueue.length,
      trackIds: jobs.map(j => j.trackId),
    });
  }
  void runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (pendingQueue.length > 0) {
      const auth = useAuthStore.getState();
      if (!auth.isLoggedIn || !auth.hotCacheEnabled || !auth.activeServerId) {
        hotCacheFrontendDebug({
          event: 'prefetch-worker-stop',
          reason: 'auth-disabled-or-logged-out',
          clearedPending: pendingQueue.length,
        });
        pendingQueue.length = 0;
        break;
      }

      while (getDeferHotCachePrefetch()) {
        await new Promise(r => setTimeout(r, 150));
      }

      const job = pendingQueue.shift();
      if (!job) break;

      const maxBytes = Math.max(0, auth.hotCacheMaxMb) * 1024 * 1024;
      if (maxBytes <= 0) {
        hotCacheFrontendDebug({ event: 'prefetch-skip-job', trackId: job.trackId, reason: 'max-mb-zero' });
        continue;
      }

      const offline = useOfflineStore.getState();
      if (offline.isDownloaded(job.trackId, job.serverId)) {
        hotCacheFrontendDebug({ event: 'prefetch-skip-job', trackId: job.trackId, reason: 'offline-library' });
        continue;
      }
      if (useHotCacheStore.getState().entries[entryKey(job.serverId, job.trackId)]) {
        hotCacheFrontendDebug({
          event: 'prefetch-skip-job',
          trackId: job.trackId,
          reason: 'already-in-hot-index',
        });
        continue;
      }

      const player = usePlayerStore.getState();
      const { queue, queueIndex } = player;
      const wantIds = new Set(
        queue
          .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
          .map(t => t.id),
      );
      if (!wantIds.has(job.trackId)) {
        hotCacheFrontendDebug({
          event: 'prefetch-skip-job',
          trackId: job.trackId,
          reason: 'not-in-upcoming-window',
          queueIndex,
          window: PREFETCH_AHEAD,
        });
        continue;
      }

      const track = queue.find(t => t.id === job.trackId);
      if (!track) {
        hotCacheFrontendDebug({
          event: 'prefetch-skip-job',
          trackId: job.trackId,
          reason: 'track-not-in-queue',
        });
        continue;
      }
      const hotEntries = useHotCacheStore.getState().entries;
      const occupied = sumCachedBytesInProtectedWindow(queue, queueIndex, job.serverId, hotEntries);
      const est = estimateTrackHotCacheBytes(track);
      const isImmediateNext = queue[queueIndex + 1]?.id === job.trackId;
      if (!isImmediateNext && occupied + est > maxBytes) {
        hotCacheFrontendDebug({
          event: 'prefetch-skip-job',
          trackId: job.trackId,
          reason: 'budget-protected-window-plus-estimate',
          occupied,
          estimateBytes: est,
          maxBytes,
        });
        continue;
      }

      const url = buildStreamUrl(job.trackId);
      try {
        const customDir = auth.hotCacheDownloadDir || null;
        hotCacheFrontendDebug({ event: 'prefetch-invoke', trackId: job.trackId });
        const res = await invoke<{ path: string; size: number }>('download_track_hot_cache', {
          trackId: job.trackId,
          serverId: job.serverId,
          url,
          suffix: job.suffix,
          customDir,
        });
        useHotCacheStore.getState().setEntry(job.trackId, job.serverId, res.path, res.size, 'prefetch');
        hotCacheFrontendDebug({ event: 'prefetch-stored', trackId: job.trackId, sizeBytes: res.size });
        const fresh = usePlayerStore.getState();
        const authAfter = useAuthStore.getState();
        const maxAfter = Math.max(0, authAfter.hotCacheMaxMb) * 1024 * 1024;
        await useHotCacheStore.getState().evictToFit(
          fresh.queue,
          fresh.queueIndex,
          maxAfter,
          authAfter.activeServerId ?? '',
          authAfter.hotCacheDownloadDir || null,
        );
      } catch (e: unknown) {
        hotCacheFrontendDebug({ event: 'prefetch-download-failed', trackId: job.trackId, error: String(e) });
      }
    }
  } finally {
    workerRunning = false;
    if (pendingQueue.length > 0) void runWorker();
  }
}

function scheduleReplan() {
  const auth = useAuthStore.getState();
  if (!auth.isLoggedIn || !auth.hotCacheEnabled || !auth.activeServerId) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  const ms = debounceMs();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void replanNow();
  }, ms);
}

async function replanNow() {
  const auth = useAuthStore.getState();
  if (!auth.isLoggedIn || !auth.hotCacheEnabled || !auth.activeServerId) return;

  const serverId = auth.activeServerId;
  const maxBytes = Math.max(0, auth.hotCacheMaxMb) * 1024 * 1024;
  const customDir = auth.hotCacheDownloadDir || null;
  if (maxBytes <= 0) return;

  const { queue, queueIndex, currentRadio } = usePlayerStore.getState();
  if (currentRadio) {
    hotCacheFrontendDebug({ event: 'replan-skip', reason: 'radio-mode' });
    return;
  }

  const offline = useOfflineStore.getState();

  await useHotCacheStore.getState().evictToFit(queue, queueIndex, maxBytes, serverId, customDir);

  // Must read entries after eviction: the pre-evict snapshot still lists removed keys and would
  // skip prefetch for upcoming tracks that no longer have on-disk rows.
  const hotEntries = useHotCacheStore.getState().entries;

  const targets = queue.slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD);
  const immediateNextId = queue[queueIndex + 1]?.id;
  let projectedOccupied = sumCachedBytesInProtectedWindow(queue, queueIndex, serverId, hotEntries);
  const jobs: PrefetchJob[] = [];
  const skipped: { trackId: string; reason: string }[] = [];
  for (const t of targets) {
    if (offline.isDownloaded(t.id, serverId)) {
      skipped.push({ trackId: t.id, reason: 'offline-library' });
      continue;
    }
    if (hotEntries[entryKey(serverId, t.id)]) {
      skipped.push({ trackId: t.id, reason: 'already-in-hot-index' });
      continue;
    }
    const isImmediateNext = t.id === immediateNextId;
    if (isImmediateNext) {
      jobs.push({ trackId: t.id, serverId, suffix: t.suffix || 'mp3' });
      continue;
    }
    const est = estimateTrackHotCacheBytes(t);
    if (projectedOccupied + est > maxBytes) {
      skipped.push({ trackId: t.id, reason: 'budget-cap-rest-deferred' });
      break;
    }
    projectedOccupied += est;
    jobs.push({ trackId: t.id, serverId, suffix: t.suffix || 'mp3' });
  }
  hotCacheFrontendDebug({
    event: 'replan',
    queueIndex,
    aheadCount: targets.length,
    scheduledIds: jobs.map(j => j.trackId),
    skipped,
    projectedOccupiedBytes: projectedOccupied,
    maxBytes,
  });
  enqueueJobs(jobs);
}

/**
 * Subscribe to queue/auth changes and run debounced prefetch.
 * Call once from the app shell.
 */
export function initHotCachePrefetch(): () => void {
  let lastQueueRef: unknown = null;
  let lastQueueIndex = -1;
  const unsubPlayer = usePlayerStore.subscribe(state => {
    const q = state.queue;
    const i = state.queueIndex;
    if (q === lastQueueRef && i === lastQueueIndex) return;
    const prevIdx = lastQueueIndex;
    const prevQ = lastQueueRef;
    const onlyIndexMoved = q === lastQueueRef && i !== lastQueueIndex;
    lastQueueRef = q;
    lastQueueIndex = i;
    scheduleAnalysisQueuePruneFromPlaybackQueue();
    if (onlyIndexMoved && i > prevIdx && prevIdx >= 0 && Array.isArray(prevQ)) {
      const left = (prevQ as Track[])[prevIdx];
      const a = useAuthStore.getState();
      if (left && a.activeServerId) {
        bumpHotCachePreviousTrackGrace(left.id, a.activeServerId, a.hotCacheDebounceSec);
        scheduleEvictAfterPreviousGrace();
      }
    }
    if (onlyIndexMoved) void replanNow();
    else scheduleReplan();
  });

  let lastAuthSig = '';
  const unsubAuth = useAuthStore.subscribe((state, prev) => {
    const sig = `${state.hotCacheEnabled}:${state.hotCacheDebounceSec}:${state.hotCacheMaxMb}:${state.hotCacheDownloadDir ?? ''}:${state.activeServerId ?? ''}:${state.isLoggedIn}`;
    if (sig === lastAuthSig) return;
    lastAuthSig = sig;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (!state.hotCacheEnabled || !state.isLoggedIn) {
      hotCacheFrontendDebug({ event: 'prefetch-auth-off', clearedPending: pendingQueue.length });
      pendingQueue.length = 0;
      clearHotCachePreviousGrace();
      return;
    }

    const budgetSettingsChanged =
      !prev ||
      state.hotCacheMaxMb !== prev.hotCacheMaxMb ||
      state.hotCacheDownloadDir !== prev.hotCacheDownloadDir ||
      state.hotCacheEnabled !== prev.hotCacheEnabled ||
      state.activeServerId !== prev.activeServerId ||
      state.isLoggedIn !== prev.isLoggedIn;

    const onlyDebounceChanged =
      !!prev &&
      state.hotCacheDebounceSec !== prev.hotCacheDebounceSec &&
      !budgetSettingsChanged;

    if (budgetSettingsChanged) {
      if (prev && state.hotCacheMaxMb < prev.hotCacheMaxMb) {
        hotCacheFrontendDebug({
          event: 'prefetch-pending-cleared',
          reason: 'hot-cache-max-mb-decreased',
          prevMb: prev.hotCacheMaxMb,
          nextMb: state.hotCacheMaxMb,
          droppedJobs: pendingQueue.length,
        });
        pendingQueue.length = 0;
      }
      void replanNow();
    } else if (onlyDebounceChanged) {
      scheduleReplan();
    }
  });

  void replanNow();
  scheduleAnalysisQueuePruneFromPlaybackQueue();

  return () => {
    unsubPlayer();
    unsubAuth();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (graceEvictTimer) clearTimeout(graceEvictTimer);
    graceEvictTimer = null;
    resetAnalysisPruneState();
    pendingQueue.length = 0;
    clearHotCachePreviousGrace();
  };
}
