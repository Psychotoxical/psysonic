import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { reconcileCanonicalEntityIds } from '@/utils/server/reconcileCanonicalEntityIds';
import { subscribeLibrarySyncIdle } from '@/lib/api/library';

export function useLibraryIdentityBridge(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeLibrarySyncIdle(payload => {
      if (payload.ok || !payload.error?.startsWith('identity transition:')) return;
      const serverIndexKey = payload.serverId;
      const profile = useAuthStore.getState().servers.find(
        server => serverIndexKeyForProfile(server) === serverIndexKey,
      );
      if (profile) void reconcileCanonicalEntityIds(profile, serverIndexKey).catch(() => {});
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
