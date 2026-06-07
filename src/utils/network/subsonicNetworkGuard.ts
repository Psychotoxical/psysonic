import { useAuthStore } from '../../store/authStore';
import { resolvePlaybackUrl } from '../playback/resolvePlaybackUrl';
import { isDevOfflineBrowseForced } from '../../store/devOfflineBrowseStore';
import { isActiveServerReachable } from './activeServerReachability';

/**
 * Whether a Subsonic API call for `serverId` is worth attempting.
 * Skips when the browser or active server is down, or when the track already
 * plays from a local `psysonic-local://` URL (offline / favorite-auto bytes).
 */
export function shouldAttemptSubsonicForServer(serverId: string, trackId?: string): boolean {
  if (!serverId) return false;
  if (isDevOfflineBrowseForced()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  if (trackId) {
    const url = resolvePlaybackUrl(trackId, serverId);
    if (url.startsWith('psysonic-local://')) return false;
  }
  return isActiveServerReachable();
}

/** Convenience for call sites that only know the active server id. */
export function shouldAttemptSubsonicForActiveServer(): boolean {
  const activeId = useAuthStore.getState().activeServerId;
  return activeId ? shouldAttemptSubsonicForServer(activeId) : false;
}
