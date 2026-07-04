import { useAuthStore } from '@/store/authStore';
import { hasLocalPlaybackUrl } from '@/store/localPlaybackResolve';
import { isDevOfflineBrowseForced } from '@/store/devOfflineBrowseStore';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { isActiveServerReachable } from '@/lib/network/activeServerReachability';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';

function isSameServerProfile(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return resolveServerIdForIndexKey(a) === resolveServerIdForIndexKey(b);
}

/**
 * Whether `serverId` is worth a best-effort Subsonic call while the browser is
 * online. The active profile uses the connection-status probe; other profiles
 * (e.g. queue playback while browsing another server) attempt optimistically.
 */
export function isSubsonicServerReachable(serverId: string): boolean {
  if (!serverId) return false;
  if (isDevOfflineBrowseForced()) return false;
  if (isNavigatorOfflineHint()) return false;
  const activeId = useAuthStore.getState().activeServerId;
  if (!activeId || isSameServerProfile(serverId, activeId)) {
    return isActiveServerReachable();
  }
  return true;
}

/**
 * Whether a Subsonic API call for `serverId` is worth attempting.
 * Skips when the browser or target server is down, or when the track already
 * plays from a local `psysonic-local://` URL (offline / favorite-auto bytes).
 */
export function shouldAttemptSubsonicForServer(serverId: string, trackId?: string): boolean {
  if (!serverId) return false;
  if (isDevOfflineBrowseForced()) return false;
  if (isNavigatorOfflineHint()) return false;
  if (trackId && hasLocalPlaybackUrl(trackId, serverId)) return false;
  return isSubsonicServerReachable(serverId);
}

/** Convenience for call sites that only know the active server id. */
export function shouldAttemptSubsonicForActiveServer(): boolean {
  const activeId = useAuthStore.getState().activeServerId;
  return activeId ? shouldAttemptSubsonicForServer(activeId) : false;
}
