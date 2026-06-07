import { isDevOfflineBrowseForced } from '../../store/devOfflineBrowseStore';

/**
 * Active-server reachability snapshot maintained by `useConnectionStatus`.
 * Non-hook code (queue sync, favorites refresh) uses this to avoid noisy
 * network attempts while the browser or Subsonic endpoint is down.
 */
let activeServerReachable: boolean | null = null;

const reachableListeners = new Set<() => void>();

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

/** True only when the browser is online and the last active-server probe succeeded. */
export function isActiveServerReachable(): boolean {
  if (isDevOfflineBrowseForced()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  return activeServerReachable === true;
}
