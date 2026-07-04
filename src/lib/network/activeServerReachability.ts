import { isDevOfflineBrowseForced } from '@/store/devOfflineBrowseStore';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';

export type ConnectionStatus = 'connected' | 'disconnected' | 'checking';

/**
 * Active-server reachability snapshot maintained by `useConnectionStatus`.
 * Non-hook code (queue sync, favorites refresh) uses this to avoid noisy
 * network attempts while the browser or Subsonic endpoint is down.
 */
let activeServerReachable: boolean | null = null;
let connectionStatus: ConnectionStatus = 'checking';

const reachableListeners = new Set<() => void>();
const connectionStatusListeners = new Set<() => void>();

/** Fires when the active server transitions to reachable (`false`/`null` → `true`). */
export function onActiveServerBecameReachable(listener: () => void): () => void {
  reachableListeners.add(listener);
  return () => reachableListeners.delete(listener);
}

export function setActiveServerReachable(ok: boolean | null): void {
  const wasReachable = activeServerReachable === true;
  activeServerReachable = ok;
  if (!wasReachable && ok === true) {
    for (const listener of reachableListeners) listener();
  }
}

export function getActiveServerReachable(): boolean | null {
  return activeServerReachable;
}

/** Shared across all `useConnectionStatus` hook instances (manual retry, polling). */
export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}

export function setConnectionStatus(next: ConnectionStatus): void {
  if (connectionStatus === next) return;
  connectionStatus = next;
  for (const listener of connectionStatusListeners) listener();
}

export function subscribeConnectionStatus(listener: () => void): () => void {
  connectionStatusListeners.add(listener);
  return () => connectionStatusListeners.delete(listener);
}

/** Test helper — resets module-level connection snapshot. */
export function resetActiveServerConnectionSnapshot(): void {
  activeServerReachable = null;
  connectionStatus = 'checking';
}

/** True only when no navigator offline hint applies and the last active-server probe succeeded. */
export function isActiveServerReachable(): boolean {
  if (isDevOfflineBrowseForced()) return false;
  if (isNavigatorOfflineHint()) return false;
  return activeServerReachable === true;
}
