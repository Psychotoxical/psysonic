import {
  libraryGetStatus,
  librarySyncStart,
  librarySyncVerifyIntegrity,
  subscribeLibrarySyncIdle,
  type LibrarySyncIdlePayload,
} from '@/lib/api/library';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { libraryDevEnabled, logLibrarySync } from './libraryDevLog';
import { invalidateGenreCatalogCache } from './genreCatalogCountsCache';
import { clearArtistBrowseCatalogCache } from './artistBrowseInflight';
import { clearAlbumBrowseCatalogCache } from './albumBrowseInflight';
import { clearArtistIdResolveCache } from './artistIdResolve';

export type LibrarySyncQueueKind = 'full' | 'delta' | 'verify';

interface QueueItem {
  serverId: string;
  kind: LibrarySyncQueueKind;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const queue: QueueItem[] = [];
let draining = false;
let activeItem: QueueItem | null = null;
let idleListener: Promise<UnlistenFn> | null = null;
let waitingForIdle: {
  serverId: string;
  jobId: string;
  resolve: () => void;
  reject: (err: unknown) => void;
} | null = null;
const completedIdleByJobId = new Map<string, LibrarySyncIdlePayload>();

function logQueue(message: string, serverId?: string, kind?: LibrarySyncQueueKind): void {
  if (!libraryDevEnabled()) return;
  logLibrarySync({
    at: new Date().toISOString(),
    kind: 'sync_queue',
    serverId: serverId ?? '',
    message: `[queue ${queue.length}${draining ? ', draining' : ''}] ${message}${kind ? ` (${kind})` : ''}`,
  });
}

function ensureIdleListener(): Promise<UnlistenFn> {
  if (!idleListener) {
    idleListener = subscribeLibrarySyncIdle(onSyncIdle);
  }
  return idleListener;
}

function onSyncIdle(payload: LibrarySyncIdlePayload): void {
  if (payload.ok) {
    // The re-key on the sync revision (offlineLocalLibrarySyncRevision) is what
    // actually drives the refetch after a sync added/renamed/pruned rows. These
    // clears are complementary memory reclamation — they drop inflight promises
    // and stale buffered chunks so they don't linger. Unlike the genre cache
    // (keyed per serverId), the artist/album catalog caches have no serverId
    // scope, so this clears every server's buffer; the only cost is a wasted
    // refetch of identical data on another server's next render.
    invalidateGenreCatalogCache(payload.serverId);
    clearArtistBrowseCatalogCache();
    clearAlbumBrowseCatalogCache();
  }
  // Artist rows can appear with a sync; a cached "no artist row" must not outlive it.
  // Not gated on `ok`: sync writes incrementally, so a run that inserted artists and
  // then failed a later pass — or one whose index changes were fine but whose
  // post-run identity maintenance reported failure — still leaves rows the cache
  // would otherwise keep denying. Re-reading a few names is cheaper than a guest that
  // stays unlinkable until restart.
  clearArtistIdResolveCache();
  if (payload.source === 'background') return;
  if (!payload.jobId) return;
  if (
    !waitingForIdle
    || waitingForIdle.serverId !== payload.serverId
    || waitingForIdle.jobId !== payload.jobId
  ) {
    completedIdleByJobId.set(payload.jobId, payload);
    if (completedIdleByJobId.size > 32) {
      completedIdleByJobId.delete(completedIdleByJobId.keys().next().value!);
    }
    return;
  }
  settleIdleWaiter(payload);
}

function settleIdleWaiter(payload: LibrarySyncIdlePayload): void {
  if (!waitingForIdle) return;
  const waiter = waitingForIdle;
  waitingForIdle = null;
  if (payload.ok) {
    logQueue(`idle ok for ${payload.serverId}`, payload.serverId);
    waiter.resolve();
    return;
  }
  logQueue(`idle error for ${payload.serverId}: ${payload.error ?? 'unknown'}`, payload.serverId);
  waiter.reject(new Error(payload.error ?? 'library sync failed'));
}

function waitForServerIdle(serverId: string, jobId: string): Promise<void> {
  const completed = completedIdleByJobId.get(jobId);
  if (completed) {
    completedIdleByJobId.delete(jobId);
    if (completed.ok) return Promise.resolve();
    return Promise.reject(new Error(completed.error ?? 'library sync failed'));
  }
  return new Promise((resolve, reject) => {
    waitingForIdle = { serverId, jobId, resolve, reject };
  });
}

/** Wait until a server emits `library:sync-idle`, or time out (best-effort). */
export function waitForLibrarySyncIdle(serverId: string, timeoutMs = 15_000): Promise<void> {
  return new Promise(resolve => {
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve();
    }, timeoutMs);
    void subscribeLibrarySyncIdle(p => {
      if (p.serverId !== serverId || p.source === 'background') return;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    }).then(fn => {
      unlisten = fn;
    });
  });
}

async function invokeSync(serverId: string, kind: LibrarySyncQueueKind): Promise<string> {
  if (kind === 'verify') {
    return (await librarySyncVerifyIntegrity({ serverId })).jobId;
  }
  return (await librarySyncStart({ serverId, mode: kind === 'full' ? 'full' : 'delta' })).jobId;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await ensureIdleListener();
  } catch (error) {
    idleListener = null;
    draining = false;
    activeItem = null;
    if (waitingForIdle) {
      waitingForIdle.reject(error);
      waitingForIdle = null;
    }
    const failed = queue.splice(0, queue.length);
    for (const item of failed) item.reject(error);
    return;
  }
  while (queue.length > 0) {
    const item = queue[0]!;
    activeItem = item;
    logQueue(`start ${item.serverId}`, item.serverId, item.kind);
    try {
      const jobId = await invokeSync(item.serverId, item.kind);
      await waitForServerIdle(item.serverId, jobId);
      queue.shift();
      item.resolve();
    } catch (err) {
      if (waitingForIdle?.serverId === item.serverId) waitingForIdle = null;
      queue.shift();
      item.reject(err);
    } finally {
      if (activeItem === item) activeItem = null;
    }
  }
  draining = false;
  if (queue.length > 0) void drainQueue();
}

const SYNC_KIND_PRECEDENCE: Record<LibrarySyncQueueKind, number> = {
  delta: 1,
  verify: 2,
  full: 3,
};

function kindSatisfies(
  existing: LibrarySyncQueueKind,
  requested: LibrarySyncQueueKind,
): boolean {
  return SYNC_KIND_PRECEDENCE[existing] >= SYNC_KIND_PRECEDENCE[requested];
}

function createQueueItem(args: {
  serverId: string;
  kind: LibrarySyncQueueKind;
}): QueueItem {
  let resolveItem!: () => void;
  let rejectItem!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveItem = resolve;
    rejectItem = reject;
  });
  return { ...args, promise, resolve: resolveItem, reject: rejectItem };
}

/**
 * Run library sync jobs one at a time. Waits for `library:sync-idle` before
 * starting the next server so bulk ingest passes do not cancel each other.
 */
export function enqueueLibrarySync(args: {
  serverId: string;
  kind: LibrarySyncQueueKind;
}): Promise<void> {
  logQueue(`enqueue ${args.serverId}`, args.serverId, args.kind);
  const matching = queue.filter(item => item.serverId === args.serverId);
  const pending = matching.find(item => item !== activeItem);
  if (pending) {
    if (!kindSatisfies(pending.kind, args.kind)) {
      logQueue(`upgrade pending ${args.serverId}`, args.serverId, args.kind);
      pending.kind = args.kind;
    }
    return pending.promise;
  }

  const active = matching.find(item => item === activeItem);
  if (active && kindSatisfies(active.kind, args.kind)) return active.promise;

  const item = createQueueItem(args);
  queue.push(item);
  void drainQueue();
  return item.promise;
}

/** True while this webview has queued or started matching native sync work. */
export function hasLibrarySyncWork(serverId: string, kind?: LibrarySyncQueueKind): boolean {
  return queue.some(item => item.serverId === serverId && (!kind || item.kind === kind));
}

/** Remove queued work for one server while leaving its already-running job to native cancel. */
export function clearPendingLibrarySync(serverId: string): number {
  let removed = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (item.serverId !== serverId || item === activeItem) continue;
    queue.splice(index, 1);
    item.resolve();
    removed += 1;
  }
  if (removed > 0) logQueue(`cleared pending ${serverId}`, serverId);
  return removed;
}

/** Skip enqueue when the local index is already complete. */
export async function queueInitialSyncIfNeeded(serverId: string): Promise<void> {
  try {
    const status = await libraryGetStatus(serverId);
    if (status.syncPhase === 'initial_sync') return;
    if (status.syncPhase === 'ready' || status.lastFullSyncAt) return;
    await enqueueLibrarySync({ serverId, kind: 'full' });
  } catch {
    /* best-effort */
  }
}

/** Test-only reset — clears pending work and idle waiters. */
export function resetLibrarySyncQueueForTests(): void {
  const pending = queue.splice(0, queue.length);
  for (const item of pending) item.reject(new Error('queue reset'));
  draining = false;
  activeItem = null;
  if (waitingForIdle) {
    waitingForIdle.reject(new Error('queue reset'));
  waitingForIdle = null;
  completedIdleByJobId.clear();
  }
  void idleListener?.then(unlisten => unlisten());
  idleListener = null;
}
