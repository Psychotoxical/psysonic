import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LibraryScopePair } from '@/lib/api/library';
import {
  buildBrowseLibraryScopePairs,
  configuredLibraryServerIds,
  libraryScopeFingerprint,
} from '@/lib/library/libraryBrowseScope';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

export interface BrowseLibraryScope {
  pairs: LibraryScopePair[];
  fingerprint: string;
  anchorServerId: string;
  configuredServerIds: string[];
  multiServer: boolean;
}

export function useBrowseLibraryScope(): BrowseLibraryScope {
  const authScope = useAuthStore(useShallow(state => ({
    servers: state.servers,
    activeServerId: state.activeServerId,
    musicLibraryServerIds: state.musicLibraryServerIds,
    musicLibrarySelectionByServer: state.musicLibrarySelectionByServer,
    musicLibraryFilterByServer: state.musicLibraryFilterByServer,
  })));
  const runtime = useLibraryIndexStore(useShallow(state => ({
    statusByServer: state.statusByServer,
    connectionByServer: state.connectionByServer,
  })));

  return useMemo(() => {
    const configuredServerIds = configuredLibraryServerIds(authScope);
    const pairs = buildBrowseLibraryScopePairs(authScope, runtime, {
      navigatorOffline: isNavigatorOfflineHint(),
    });
    return {
      pairs,
      fingerprint: libraryScopeFingerprint(pairs),
      anchorServerId: pairs[0]?.serverId ?? configuredServerIds[0] ?? authScope.activeServerId ?? '',
      configuredServerIds,
      multiServer: configuredServerIds.length > 1,
    };
  }, [authScope, runtime]);
}
