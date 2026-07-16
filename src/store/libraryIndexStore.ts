import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SyncStateDto } from '@/lib/api/library/dto';
import type { LibraryServerConnection } from '@/lib/network/libraryServerReachability';
import { replaceLibraryServerConnectionSnapshot } from '@/lib/network/libraryServerReachability';

/**
 * Settings for the local library index (spec §7.3).
 * Index is always on for configured servers; sync controls live under Settings → Servers.
 */
interface LibraryIndexState {
  /** Always true (kept for persisted-state migration and existing call sites). */
  masterEnabled: boolean;
  isIndexEnabled: (serverId: string | null | undefined) => boolean;
  indexedServerIds: (allServerIds: string[]) => string[];
  statusByServer: Record<string, SyncStateDto | null>;
  connectionByServer: Record<string, LibraryServerConnection>;
  replaceStatuses: (statusByServer: Record<string, SyncStateDto | null>) => void;
  replaceConnections: (connectionByServer: Record<string, LibraryServerConnection>) => void;
  mergeConnections: (connectionByServer: Record<string, LibraryServerConnection>) => void;
}

export const useLibraryIndexStore = create<LibraryIndexState>()(
  persist(
    (set, get) => ({
      masterEnabled: true,
      isIndexEnabled: serverId => !!serverId && get().masterEnabled,
      indexedServerIds: allServerIds => (get().masterEnabled ? allServerIds : []),
      statusByServer: {},
      connectionByServer: {},
      replaceStatuses: statusByServer => {
        set({ statusByServer });
      },
      replaceConnections: connectionByServer => {
        set({ connectionByServer });
        replaceLibraryServerConnectionSnapshot(connectionByServer);
      },
      mergeConnections: updates => {
        const connectionByServer = { ...get().connectionByServer, ...updates };
        set({ connectionByServer });
        replaceLibraryServerConnectionSnapshot(connectionByServer);
      },
    }),
    {
      name: 'psysonic-library-index',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, _version) => {
        const previous = persisted as { masterEnabled?: boolean } | undefined;
        return { masterEnabled: previous?.masterEnabled ?? true };
      },
      partialize: state => ({ masterEnabled: state.masterEnabled }),
    },
  ),
);

export type { LibraryServerConnection };
