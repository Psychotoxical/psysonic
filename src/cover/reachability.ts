import { useAuthStore } from '../store/authStore';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';
import type { CoverServerScope } from './types';

/** Per-server reachability — active/playback use navigator + configured server */
export function coverServerReachable(scope: CoverServerScope): boolean {
  if (scope.kind === 'server') {
    return !!scope.url && !!scope.username;
  }
  if (isNavigatorOfflineHint()) return false;
  const active = useAuthStore.getState().getActiveServer();
  const baseUrl = useAuthStore.getState().getBaseUrl();
  return !!(active && baseUrl);
}
