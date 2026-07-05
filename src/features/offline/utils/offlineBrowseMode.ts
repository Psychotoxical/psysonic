import {
  isDevOfflineBrowseForced,
  useDevOfflineBrowseStore,
} from '@/store/devOfflineBrowseStore';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { isActiveServerReachable } from '@/lib/network/activeServerReachability';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';

/** True when browse/detail pages should use local-bytes-only data sources. */
export function isOfflineBrowseActive(): boolean {
  if (isDevOfflineBrowseForced()) return true;
  if (isNavigatorOfflineHint()) return true;
  return !isActiveServerReachable();
}

/**
 * Reactive offline-browse flag for React trees. Re-renders when the DEV toggle,
 * browser online state, or active-server connection status changes.
 */
export function useOfflineBrowseActive(): boolean {
  const devForceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  // Shared status — all hook instances stay in sync after manual retry.
  useConnectionStatus();

  if (import.meta.env.DEV && devForceOffline) return true;
  if (isNavigatorOfflineHint()) return true;
  return !isActiveServerReachable();
}
