import { useAuthStore } from '../store/authStore';
import type { CoverServerScope } from './types';

/** Per-server reachability — wired to auth connection state */
export function coverServerReachable(scope: CoverServerScope): boolean {
  if (scope.kind === 'server') {
    const s = useAuthStore.getState().servers.find(x => x.id === scope.serverId);
    return s?.connected !== false;
  }
  const active = useAuthStore.getState().getActiveServer();
  return active?.connected !== false;
}
