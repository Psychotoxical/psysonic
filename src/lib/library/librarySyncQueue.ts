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

export type LibrarySyncQueueKind = 'full' | 'delta' | 'verify';

interface QueueItem {
  serverId: string;
  kind: LibrarySyncQueueKind;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const queue: QueueItem[] = [];
let draining = false;
let idleListener: Promise<UnlistenFn> | null = null;
let waitingForIdle: {
  serverId: string;
  resolve: () => void;
  reject: (err: unknown) => void;
} | null = null;

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
  if (payload.ok) invalidateGenreCatalogCache(payload.serverId);
  if (!waitingForIdle || waitingForIdle.serverId !== payload.serverId) return;
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

function waitForServerIdle(serverId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    waitingForIdle = { serverId, resolve, reject };
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
      if (p.serverId !== serverId) return;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    }).then(fn => {
      unlisten = fn;
    });
  });
}

async function invokeSync(serverId: string, kind: LibrarySyncQueueKind): Promise<void> {
  if (kind === 'verify') {
    await librarySyncVerifyIntegrity({ serverId });
    return;
  }
  await librarySyncStart({ serverId, mode: kind === 'full' ? 'full' : 'delta' });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  await ensureIdleListener();
  while (queue.length > 0) {
    const item = queue[0]!;
    logQueue(`start ${item.serverId}`, item.serverId, item.kind);
    try {
      const idlePromise = waitForServerIdle(item.serverId);
      await invokeSync(item.serverId, item.kind);
      await idlePromise;
      queue.shift();
      item.resolve();
    } catch (err) {
      queue.shift();
      item.reject(err);
    }
  }
  draining = false;
  if (queue.length > 0) void drainQueue();
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
  if (queue.some(item => item.serverId === args.serverId && item.kind === args.kind)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    queue.push({ ...args, resolve, reject });
    void drainQueue();
  });
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
  queue.splice(0, queue.length);
  draining = false;
  if (waitingForIdle) {
    waitingForIdle.reject(new Error('queue reset'));
    waitingForIdle = null;
  }
  void idleListener?.then(unlisten => unlisten());
  idleListener = null;
}
