import {
  isDevOfflineBrowseForced,
  useDevOfflineBrowseStore,
} from '../../store/devOfflineBrowseStore';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { isActiveServerReachable } from '../network/activeServerReachability';

/** True when browse/detail pages should use local-bytes-only data sources. */
export function isOfflineBrowseActive(): boolean {
  if (isDevOfflineBrowseForced()) return true;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  return !isActiveServerReachable();
}

/**
 * Reactive offline-browse flag for React trees. Re-renders when the DEV toggle,
 * browser online state, or active-server connection status changes.
 */
export function useOfflineBrowseActive(): boolean {
  const devForceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  const { status: connStatus } = useConnectionStatus();

  if (import.meta.env.DEV && devForceOffline) return true;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (connStatus === 'disconnected') return true;
  if (connStatus === 'connected') return false;
  return !isActiveServerReachable();
}
