import { useAuthStore } from '../store/authStore';
import type { CoverServerScope } from './types';

/** Per-server reachability — active/playback use navigator + configured server */
export function coverServerReachable(scope: CoverServerScope): boolean {
  if (scope.kind === 'server') {
    return !!scope.url && !!scope.username;
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  const active = useAuthStore.getState().getActiveServer();
  const baseUrl = useAuthStore.getState().getBaseUrl();
  return !!(active && baseUrl);
}
