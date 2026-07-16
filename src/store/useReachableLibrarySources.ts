import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildReachableLibrarySources } from '@/lib/library/libraryBrowseScope';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

export function useReachableLibrarySources() {
  const auth = useAuthStore(useShallow(state => ({
    servers: state.servers,
    musicLibraryServerIds: state.musicLibraryServerIds,
    musicLibrarySelectionByServer: state.musicLibrarySelectionByServer,
    musicLibraryFilterByServer: state.musicLibraryFilterByServer,
  })));
  const connectionByServer = useLibraryIndexStore(state => state.connectionByServer);
  return useMemo(
    () => buildReachableLibrarySources(auth, { connectionByServer }, {
      navigatorOffline: isNavigatorOfflineHint(),
    }),
    [auth, connectionByServer],
  );
}
