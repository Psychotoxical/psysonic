import { useDevOfflineBrowseStore } from '../../store/devOfflineBrowseStore';
import { isActiveServerReachable } from '../network/activeServerReachability';

/** DEV toggle: browse as offline while the server may still be reachable. */
export function isDevOfflineBrowseForced(): boolean {
  return import.meta.env.DEV && useDevOfflineBrowseStore.getState().forceOffline;
}

/** True when browse/detail pages should use local-bytes-only data sources. */
export function isOfflineBrowseActive(): boolean {
  if (isDevOfflineBrowseForced()) return true;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  return !isActiveServerReachable();
}
