import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { PinSource } from '@/store/localPlaybackStore';
import {
  cancelledDownloads,
  getOfflineDownloadCancellationVersion,
  markOfflineDownloadCancelled,
  useOfflineJobStore,
  type OfflinePinQueueEntry,
} from '@/features/offline/store/offlineJobStore';

export type OfflinePinKind = PinSource['kind'];

export interface OfflinePinTask {
  albumId: string;
  albumName: string;
  albumArtist: string;
  coverArt: string | undefined;
  year: number | undefined;
  songs: SubsonicSong[];
  serverId: string;
  type: OfflinePinKind;
  /** When set, bump `bulkProgress[groupId].done` after each album finishes. */
  artistProgressGroupId?: string;
}

export type OfflinePinResult = 'completed' | 'cancelled';

type OfflinePinExecutor = (
  task: OfflinePinTask,
  markStarted: () => void,
  cancellationVersion: number,
) => Promise<OfflinePinResult | void>;

interface QueuedPinTask {
  task: OfflinePinTask;
  generation: number;
  cancellationVersion: number;
}

const pinTasks = new Map<string, QueuedPinTask>();
const activePinGenerations = new Map<string, number>();
const retiringCancellationVersions = new Map<string, number>();
const MAX_ACTIVE_PIN_EXECUTORS = 2;
let nextPinGeneration = 1;
let pinCancellationEpoch = 0;
let executor: OfflinePinExecutor | null = null;

export function registerOfflinePinExecutor(fn: OfflinePinExecutor): void {
  executor = fn;
}

export function clearOfflinePinTasks(): void {
  pinTasks.clear();
}

export function cancelAllOfflinePins(): void {
  pinCancellationEpoch += 1;
  const inactiveTaskKeys = [...pinTasks.keys()].filter(taskKey => (
    !activePinGenerations.has(taskKey)
  ));
  useOfflineJobStore.getState().cancelAllDownloads();
  for (const taskKey of inactiveTaskKeys) cancelledDownloads.delete(taskKey);
  pinTasks.clear();
  scheduleOfflinePinQueue();
}

export function getOfflinePinCancellationEpoch(): number {
  return pinCancellationEpoch;
}

function pinKey(albumId: string, serverId?: string): string {
  return serverId ? `${serverId}:${albumId}` : albumId;
}

function pinGenerationKey(taskKey: string, generation: number): string {
  return `${taskKey}:${generation}`;
}

export function removeOfflinePinTask(
  albumId: string,
  serverId?: string,
  pinKind?: OfflinePinKind,
): void {
  const taskKey = pinKey(albumId, serverId);
  const queuedTask = pinTasks.get(taskKey);
  if (pinKind && queuedTask?.task.type !== pinKind) return;
  pinTasks.delete(taskKey);
  if (queuedTask?.task.artistProgressGroupId && !activePinGenerations.has(taskKey)) {
    useOfflineJobStore.getState().dropBulkProgressPending(queuedTask.task.artistProgressGroupId);
  }
}

function cancelOfflinePinTaskNow(albumId: string, serverId?: string): void {
  const taskKey = pinKey(albumId, serverId);
  const queuedTask = pinTasks.get(taskKey);
  if (queuedTask?.task.artistProgressGroupId) {
    useOfflineJobStore.getState().dropBulkProgressPending(queuedTask.task.artistProgressGroupId);
    queuedTask.task.artistProgressGroupId = undefined;
  }
  pinTasks.delete(taskKey);
}

/** True when the album is waiting in the pin queue (not actively downloading). */
export function isAlbumPinQueued(albumId: string, serverId?: string): boolean {
  return useOfflineJobStore.getState().pinQueue.some(
    p => p.albumId === albumId
      && (!serverId || !p.serverId || p.serverId === serverId)
      && p.status === 'queued',
  );
}

/** Remove a queued pin before download starts. No-op if already downloading. */
export function dequeueOfflinePin(albumId: string, serverId?: string): boolean {
  const store = useOfflineJobStore.getState();
  const entry = store.pinQueue.find(p => (
    p.albumId === albumId && (!serverId || !p.serverId || p.serverId === serverId)
  ));
  if (!entry || entry.status !== 'queued') return false;
  const taskKey = pinKey(albumId, entry.serverId ?? serverId);
  const wasActive = activePinGenerations.has(taskKey);
  store.cancelDownload(albumId, entry.serverId ?? serverId, entry.pinKind);
  cancelOfflinePinTaskNow(albumId, entry.serverId ?? serverId);
  if (!wasActive) cancelledDownloads.delete(taskKey);
  scheduleOfflinePinQueue();
  return true;
}

function isPinAlreadyScheduled(albumId: string, serverId: string): boolean {
  const { pinQueue } = useOfflineJobStore.getState();
  return pinQueue.some(p => p.albumId === albumId && (!p.serverId || p.serverId === serverId));
}

/**
 * Queue a library-tier pin. Duplicate album/playlist/artist ids coalesce to one
 * entry. Album executors may overlap; the shared track limiter owns transfer concurrency.
 */
export function enqueueOfflinePin(task: OfflinePinTask): boolean {
  const taskKey = pinKey(task.albumId, task.serverId);
  const activeGeneration = activePinGenerations.get(taskKey);
  if (activeGeneration !== undefined && cancelledDownloads.has(taskKey)) {
    // The cancelled generation may still be draining its native command. It no
    // longer owns queue admission; its generation guard keeps its finalizer
    // from removing this replacement.
    retiringCancellationVersions.set(
      pinGenerationKey(taskKey, activeGeneration),
      getOfflineDownloadCancellationVersion(taskKey),
    );
    activePinGenerations.delete(taskKey);
  }
  if (!activePinGenerations.has(taskKey)) {
    cancelledDownloads.delete(taskKey);
    cancelledDownloads.delete(task.albumId);
  }

  const store = useOfflineJobStore.getState();
  const existing = store.pinQueue.find(
    p => p.albumId === task.albumId && (!p.serverId || p.serverId === task.serverId),
  );
  if (existing?.status === 'downloading') {
    return false;
  }

  const previousTask = pinTasks.get(taskKey)?.task;
  if (
    existing?.status === 'queued'
    && previousTask
    && !previousTask.artistProgressGroupId
    && task.artistProgressGroupId
  ) {
    return false;
  }
  if (
    previousTask?.artistProgressGroupId
    && previousTask.artistProgressGroupId !== task.artistProgressGroupId
    && existing?.status === 'queued'
  ) {
    store.dropBulkProgressPending(previousTask.artistProgressGroupId);
    previousTask.artistProgressGroupId = undefined;
    const activeGeneration = activePinGenerations.get(taskKey);
    if (
      activeGeneration !== undefined
      && activeGeneration === pinTasks.get(taskKey)?.generation
    ) {
      markOfflineDownloadCancelled(taskKey);
      retiringCancellationVersions.set(
        pinGenerationKey(taskKey, activeGeneration),
        getOfflineDownloadCancellationVersion(taskKey),
      );
    }
  }
  pinTasks.set(taskKey, {
    task: { ...task },
    generation: nextPinGeneration++,
    cancellationVersion: getOfflineDownloadCancellationVersion(taskKey),
  });

  if (existing?.status === 'queued') {
    useOfflineJobStore.setState(state => ({
      pinQueue: state.pinQueue.map(entry => (
        entry === existing
          ? {
            ...entry,
            albumName: task.albumName,
            pinKind: task.type,
            serverId: task.serverId,
          }
          : entry
      )),
    }));
    scheduleOfflinePinQueue();
    return true;
  }
  if (isPinAlreadyScheduled(task.albumId, task.serverId)) {
    return false;
  }

  const entry: OfflinePinQueueEntry = {
    albumId: task.albumId,
    albumName: task.albumName,
    pinKind: task.type,
    status: 'queued',
    queuedAt: Date.now(),
    serverId: task.serverId,
  };
  useOfflineJobStore.setState(state => ({
    pinQueue: [...state.pinQueue, entry],
  }));
  scheduleOfflinePinQueue();
  return true;
}

export function scheduleOfflinePinQueue(): void {
  dispatchOfflinePinQueue();
}

async function executeOfflinePin(
  next: OfflinePinQueueEntry,
  queuedTask: QueuedPinTask,
  activeExecutor: OfflinePinExecutor,
): Promise<void> {
  const nextKey = pinKey(next.albumId, next.serverId);
  const { task, generation, cancellationVersion } = queuedTask;
  const store = useOfflineJobStore.getState();
  let result: OfflinePinResult = 'completed';
  try {
    result = (await activeExecutor(
      task,
      () => store.setPinQueueStatus(next.albumId, 'downloading', next.serverId),
      cancellationVersion,
    )) ?? 'completed';
  } catch {
    /* per-track errors are recorded on jobs; continue queue */
  } finally {
    const retiringGenerationKey = pinGenerationKey(nextKey, generation);
    const retiringCancellationVersion = retiringCancellationVersions.get(retiringGenerationKey);
    retiringCancellationVersions.delete(retiringGenerationKey);
    if (activePinGenerations.get(nextKey) === generation) {
      activePinGenerations.delete(nextKey);
    }
    const replacement = pinTasks.get(nextKey);
    if (replacement?.generation === generation) {
      if (task.artistProgressGroupId) {
        if (result === 'completed') {
          store.bumpBulkProgressDone(task.artistProgressGroupId);
        } else {
          store.dropBulkProgressPending(task.artistProgressGroupId);
        }
      }
      store.removePinFromQueue(next.albumId, next.serverId);
      pinTasks.delete(nextKey);
      cancelledDownloads.delete(nextKey);
    } else {
      // A delete/retry replaced this generation while its native call settled.
      if (
        task.artistProgressGroupId
        && replacement?.task.artistProgressGroupId !== task.artistProgressGroupId
      ) {
        store.dropBulkProgressPending(task.artistProgressGroupId);
      }
      if (
        retiringCancellationVersion !== undefined
        && getOfflineDownloadCancellationVersion(nextKey) === retiringCancellationVersion
      ) {
        cancelledDownloads.delete(nextKey);
      } else if (!replacement && !activePinGenerations.has(nextKey)) {
        cancelledDownloads.delete(nextKey);
      }
    }
    dispatchOfflinePinQueue();
  }
}

function dispatchOfflinePinQueue(): void {
  const activeExecutor = executor;
  if (!activeExecutor) return;
  const store = useOfflineJobStore.getState();
  let availableSlots = Math.max(0, MAX_ACTIVE_PIN_EXECUTORS - activePinGenerations.size);
  for (const next of store.pinQueue.filter(entry => entry.status === 'queued')) {
    if (availableSlots === 0) break;
    const nextKey = pinKey(next.albumId, next.serverId);
    if (activePinGenerations.has(nextKey)) continue;
    if (cancelledDownloads.has(nextKey)) {
      removeOfflinePinTask(next.albumId, next.serverId);
      store.removePinFromQueue(next.albumId, next.serverId);
      if (!activePinGenerations.has(nextKey)) cancelledDownloads.delete(nextKey);
      continue;
    }

    const queuedTask = pinTasks.get(nextKey);
    if (!queuedTask) {
      store.removePinFromQueue(next.albumId, next.serverId);
      continue;
    }
    activePinGenerations.set(nextKey, queuedTask.generation);
    availableSlots -= 1;
    void executeOfflinePin(next, queuedTask, activeExecutor);
  }
}
