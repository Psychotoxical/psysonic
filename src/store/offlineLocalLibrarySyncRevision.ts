import { useSyncExternalStore } from 'react';
import { subscribeLibrarySyncIdle } from '@/lib/api/library/events';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';

const syncRevisionByScope = new Map<string, number>();
const listeners = new Set<() => void>();
let syncHookRegistered = false;

function notifySyncRevisionListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function scopeKeysForServer(serverId: string): string[] {
  const keys = new Set<string>([serverId]);
  keys.add(resolveIndexKey(serverId));
  const profileId = resolveServerIdForIndexKey(serverId);
  if (profileId) keys.add(profileId);
  return [...keys];
}

function bumpOfflineLocalLibrarySyncRevision(serverIdFromEvent: string): void {
  for (const key of scopeKeysForServer(serverIdFromEvent)) {
    syncRevisionByScope.set(key, (syncRevisionByScope.get(key) ?? 0) + 1);
  }
  notifySyncRevisionListeners();
}

function ensureOfflineLocalLibrarySyncHook(): void {
  if (syncHookRegistered) return;
  syncHookRegistered = true;
  if (typeof subscribeLibrarySyncIdle !== 'function') return;
  void subscribeLibrarySyncIdle(payload => {
    if (payload.ok) {
      bumpOfflineLocalLibrarySyncRevision(payload.serverId);
    }
  });
}

/** Monotonic revision bumped after successful library sync-idle for a server scope. */
export function offlineLocalLibrarySyncRevision(serverId: string): number {
  ensureOfflineLocalLibrarySyncHook();
  let max = 0;
  for (const key of scopeKeysForServer(serverId)) {
    max = Math.max(max, syncRevisionByScope.get(key) ?? 0);
  }
  return max;
}

/** Reactive library sync revision for offline browse reload keys. */
export function useOfflineLocalLibrarySyncRevision(
  serverId: string | null | undefined,
): number {
  ensureOfflineLocalLibrarySyncHook();
  return useSyncExternalStore(
    onStoreChange => {
      listeners.add(onStoreChange);
      return () => listeners.delete(onStoreChange);
    },
    () => (serverId ? offlineLocalLibrarySyncRevision(serverId) : 0),
    () => 0,
  );
}

/** Test-only reset. */
export function resetOfflineLocalLibrarySyncRevisionForTests(): void {
  syncRevisionByScope.clear();
  syncHookRegistered = false;
}

/** Test-only bump without going through sync-idle events. */
export function bumpOfflineLocalLibrarySyncRevisionForTests(serverId: string): void {
  bumpOfflineLocalLibrarySyncRevision(serverId);
}
