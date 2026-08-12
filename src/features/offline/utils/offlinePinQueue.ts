import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { PinSource } from '@/store/localPlaybackStore';
import {
  cancelledDownloads,
  offlineAlbumIdsMatch,
  useOfflineJobStore,
  type OfflinePinQueueEntry,
} from '@/features/offline/store/offlineJobStore';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

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

type OfflinePinExecutor = (task: OfflinePinTask) => Promise<void>;

const pinTasks = new Map<string, OfflinePinTask>();
let executor: OfflinePinExecutor | null = null;
let queueDraining = false;
let drainPromise: Promise<void> | null = null;
let queuePauseDepth = 0;
let pausedPinTasks: OfflinePinTask[] = [];

export function registerOfflinePinExecutor(fn: OfflinePinExecutor): void {
  executor = fn;
}

export function clearOfflinePinTasks(resetDrain = false): void {
  pinTasks.clear();
  if (resetDrain) {
    queueDraining = false;
    drainPromise = null;
    queuePauseDepth = 0;
    pausedPinTasks = [];
  }
}

function pinKey(albumId: string, serverId?: string): string {
  return serverId ? `${serverId}:${albumId}` : albumId;
}

function canonicalAlbumId(albumId: string, serverId?: string): string {
  return serverId ? canonicalizeConfirmedNavidromeId(serverId, albumId) : albumId;
}

export function canonicalizeOfflinePinTask(task: OfflinePinTask, owner = task.serverId): OfflinePinTask {
  const canonicalize = (value: string): string => canonicalizeConfirmedNavidromeId(owner, value);
  return {
    ...task,
    albumId: canonicalize(task.albumId),
    coverArt: task.coverArt ? canonicalize(task.coverArt) : task.coverArt,
    songs: task.songs.map(song => ({
      ...song,
      id: canonicalize(song.id),
      albumId: canonicalize(song.albumId),
      artistId: song.artistId ? canonicalize(song.artistId) : song.artistId,
      coverArt: song.coverArt ? canonicalize(song.coverArt) : song.coverArt,
      artists: song.artists?.map(artist => ({
        ...artist,
        id: artist.id ? canonicalize(artist.id) : artist.id,
      })),
      albumArtists: song.albumArtists?.map(artist => ({
        ...artist,
        id: artist.id ? canonicalize(artist.id) : artist.id,
      })),
      contributors: song.contributors?.map(contributor => ({
        ...contributor,
        artist: {
          ...contributor.artist,
          id: contributor.artist.id ? canonicalize(contributor.artist.id) : contributor.artist.id,
        },
      })),
    })),
  };
}

function normalizeQueuedPins(): void {
  const queue = useOfflineJobStore.getState().pinQueue;
  const nextQueue: OfflinePinQueueEntry[] = [];
  const queueIndexByKey = new Map<string, number>();
  let changed = false;

  for (const entry of queue) {
    if (entry.status === 'downloading') {
      nextQueue.push(entry);
      continue;
    }
    const albumId = canonicalAlbumId(entry.albumId, entry.serverId);
    const oldKey = pinKey(entry.albumId, entry.serverId);
    const nextKey = pinKey(albumId, entry.serverId);
    const task = pinTasks.get(oldKey);
    if (task) {
      const activeTask = canonicalizeOfflinePinTask(task);
      pinTasks.delete(oldKey);
      pinTasks.set(nextKey, activeTask);
    }
    if (cancelledDownloads.delete(oldKey)) cancelledDownloads.add(nextKey);

    const existingIndex = queueIndexByKey.get(nextKey);
    const normalized = albumId === entry.albumId ? entry : { ...entry, albumId };
    if (existingIndex === undefined) {
      queueIndexByKey.set(nextKey, nextQueue.length);
      nextQueue.push(normalized);
    } else {
      const existing = nextQueue[existingIndex]!;
      nextQueue[existingIndex] = {
        ...normalized,
        queuedAt: Math.min(existing.queuedAt, normalized.queuedAt),
      };
      changed = true;
    }
    if (normalized !== entry) changed = true;
  }

  if (changed) useOfflineJobStore.setState({ pinQueue: nextQueue });
}

export function removeOfflinePinTask(albumId: string, serverId?: string): void {
  for (const [key, task] of pinTasks) {
    if (
      (!serverId || task.serverId === serverId)
      && offlineAlbumIdsMatch(albumId, task.albumId, task.serverId)
    ) pinTasks.delete(key);
  }
  pausedPinTasks = pausedPinTasks.filter(task => (
    (serverId && task.serverId !== serverId)
    || !offlineAlbumIdsMatch(albumId, task.albumId, task.serverId)
  ));
}

/** True when the album is waiting in the pin queue (not actively downloading). */
export function isAlbumPinQueued(albumId: string, serverId?: string): boolean {
  return useOfflineJobStore.getState().pinQueue.some(
    p => offlineAlbumIdsMatch(albumId, p.albumId, p.serverId ?? serverId)
      && (!serverId || !p.serverId || p.serverId === serverId)
      && p.status === 'queued',
  );
}

/** Remove a queued pin before download starts. No-op if already downloading. */
export function dequeueOfflinePin(albumId: string, serverId?: string): boolean {
  const store = useOfflineJobStore.getState();
  const entry = store.pinQueue.find(p => (
    offlineAlbumIdsMatch(albumId, p.albumId, p.serverId ?? serverId)
      && (!serverId || !p.serverId || p.serverId === serverId)
  ));
  if (!entry || entry.status !== 'queued') return false;
  cancelledDownloads.add(pinKey(albumId, entry.serverId ?? serverId));
  removeOfflinePinTask(albumId, entry.serverId ?? serverId);
  store.removePinFromQueue(albumId, entry.serverId ?? serverId);
  return true;
}

function isPinAlreadyScheduled(albumId: string, serverId: string): boolean {
  const { pinQueue } = useOfflineJobStore.getState();
  return pinQueue.some(p => (
    offlineAlbumIdsMatch(albumId, p.albumId, p.serverId ?? serverId)
      && (!p.serverId || p.serverId === serverId)
  ));
}

/**
 * Queue a library-tier pin. Duplicate album/playlist/artist ids coalesce to one
 * entry; the queue drains one album at a time so parallel pins do not evict each other.
 */
export function enqueueOfflinePin(task: OfflinePinTask): boolean {
  const activeTask = canonicalizeOfflinePinTask(task);
  if (queuePauseDepth > 0) {
    const existingIndex = pausedPinTasks.findIndex(candidate => (
      candidate.serverId === activeTask.serverId
      && offlineAlbumIdsMatch(activeTask.albumId, candidate.albumId, activeTask.serverId)
    ));
    if (existingIndex >= 0) pausedPinTasks[existingIndex] = activeTask;
    else pausedPinTasks.push(activeTask);
    return true;
  }
  normalizeQueuedPins();
  const taskKey = pinKey(activeTask.albumId, activeTask.serverId);
  cancelledDownloads.delete(taskKey);
  cancelledDownloads.delete(activeTask.albumId);

  const store = useOfflineJobStore.getState();
  const existing = store.pinQueue.find(
    p => canonicalAlbumId(p.albumId, p.serverId) === activeTask.albumId
      && (!p.serverId || p.serverId === activeTask.serverId),
  );
  if (existing?.status === 'downloading') {
    return false;
  }

  pinTasks.set(taskKey, activeTask);

  if (existing?.status === 'queued') {
    useOfflineJobStore.setState(state => ({
      pinQueue: state.pinQueue.map(entry => (
        entry === existing
          ? { ...entry, albumName: activeTask.albumName, pinKind: activeTask.type }
          : entry
      )),
    }));
    scheduleOfflinePinQueue();
    return true;
  }
  if (isPinAlreadyScheduled(activeTask.albumId, activeTask.serverId)) {
    return false;
  }

  const entry: OfflinePinQueueEntry = {
    albumId: activeTask.albumId,
    albumName: activeTask.albumName,
    pinKind: activeTask.type,
    status: 'queued',
    queuedAt: Date.now(),
    serverId: activeTask.serverId,
  };
  useOfflineJobStore.setState(state => ({
    pinQueue: [...state.pinQueue, entry],
  }));
  scheduleOfflinePinQueue();
  return true;
}

export function scheduleOfflinePinQueue(): void {
  void ensureOfflinePinQueueDrain();
}

function ensureOfflinePinQueueDrain(): Promise<void> {
  if (!drainPromise) {
    const current = drainOfflinePinQueue();
    drainPromise = current;
    void current.finally(() => {
      if (drainPromise !== current) return;
      drainPromise = null;
      if (useOfflineJobStore.getState().pinQueue.some(p => p.status === 'queued')) {
        void ensureOfflinePinQueueDrain();
      }
    });
  }
  return drainPromise;
}

export async function cancelAndDrainOfflinePinQueue(): Promise<void> {
  queuePauseDepth += 1;
  if (queuePauseDepth === 1) pausedPinTasks = [...pinTasks.values()];
  useOfflineJobStore.getState().cancelAllDownloads();
  clearOfflinePinTasks();
  await drainPromise;
}

export function resumeOfflinePinQueue(): void {
  if (queuePauseDepth === 0) return;
  queuePauseDepth -= 1;
  if (queuePauseDepth > 0) return;
  const tasks = pausedPinTasks;
  pausedPinTasks = [];
  for (const task of tasks) enqueueOfflinePin(canonicalizeOfflinePinTask(task));
}

async function drainOfflinePinQueue(): Promise<void> {
  if (queueDraining || !executor) return;
  queueDraining = true;
  try {
    while (true) {
      normalizeQueuedPins();
      const store = useOfflineJobStore.getState();
      const next = store.pinQueue.find(p => p.status === 'queued');
      if (!next) break;

      const nextKey = pinKey(next.albumId, next.serverId);
      if (cancelledDownloads.has(nextKey)) {
        store.removePinFromQueue(next.albumId, next.serverId);
        pinTasks.delete(nextKey);
        continue;
      }

      const task = pinTasks.get(nextKey);
      if (!task) {
        store.removePinFromQueue(next.albumId, next.serverId);
        continue;
      }

      store.setPinQueueStatus(next.albumId, 'downloading', next.serverId);
      try {
        await executor(canonicalizeOfflinePinTask(task));
      } catch {
        /* per-track errors are recorded on jobs; continue queue */
      } finally {
        if (task.artistProgressGroupId) {
          store.bumpBulkProgressDone(task.artistProgressGroupId);
        }
        store.removePinFromQueue(next.albumId, next.serverId);
        pinTasks.delete(nextKey);
      }
    }
  } finally {
    queueDraining = false;
  }
}
