/**
 * Active-server reachability snapshot maintained by `useConnectionStatus`.
 * Non-hook code (queue sync, favorites refresh) uses this to avoid noisy
 * network attempts while the browser or Subsonic endpoint is down.
 */
let activeServerReachable: boolean | null = null;

export function setActiveServerReachable(ok: boolean | null): void {
  activeServerReachable = ok;
}

export function getActiveServerReachable(): boolean | null {
  return activeServerReachable;
}

/** True only when the browser is online and the last active-server probe succeeded. */
export function isActiveServerReachable(): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  return activeServerReachable === true;
}
