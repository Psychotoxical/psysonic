import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

type PersistedV0 = {
  indexEnabledByServer?: Record<string, boolean>;
  autoReconcileEnabled?: boolean;
};

/**
 * Settings for the local library index (spec §7.3).
 * Master toggle indexes all configured servers; per-server exclusion opt-out.
 */
interface LibraryIndexState {
  masterEnabled: boolean;
  /** `serverId → true` excludes that server while master is on. */
  syncExcludedByServer: Record<string, boolean>;
  autoReconcileEnabled: boolean;
  setMasterEnabled: (enabled: boolean) => void;
  /** Legacy API — enables master and clears exclusion, or excludes one server. */
  setIndexEnabled: (serverId: string, enabled: boolean) => void;
  setServerSyncExcluded: (serverId: string, excluded: boolean) => void;
  setAutoReconcileEnabled: (enabled: boolean) => void;
  isIndexEnabled: (serverId: string | null | undefined) => boolean;
  indexedServerIds: (allServerIds: string[]) => string[];
}

export const useLibraryIndexStore = create<LibraryIndexState>()(
  persist(
    (set, get) => ({
      masterEnabled: false,
      syncExcludedByServer: {},
      autoReconcileEnabled: true,
      setMasterEnabled: enabled => set({ masterEnabled: enabled }),
      setIndexEnabled: (serverId, enabled) => {
        if (enabled) {
          set(s => {
            const { [serverId]: _omit, ...syncExcludedByServer } = s.syncExcludedByServer;
            return { masterEnabled: true, syncExcludedByServer };
          });
        } else {
          set(s => ({
            syncExcludedByServer: { ...s.syncExcludedByServer, [serverId]: true },
          }));
        }
      },
      setServerSyncExcluded: (serverId, excluded) => {
        if (excluded) {
          set(s => ({
            syncExcludedByServer: { ...s.syncExcludedByServer, [serverId]: true },
          }));
        } else {
          set(s => {
            const { [serverId]: _omit, ...syncExcludedByServer } = s.syncExcludedByServer;
            return { syncExcludedByServer };
          });
        }
      },
      setAutoReconcileEnabled: enabled => set({ autoReconcileEnabled: enabled }),
      isIndexEnabled: serverId => {
        if (!serverId || !get().masterEnabled) return false;
        return get().syncExcludedByServer[serverId] !== true;
      },
      indexedServerIds: allServerIds => {
        if (!get().masterEnabled) return [];
        return allServerIds.filter(id => get().syncExcludedByServer[id] !== true);
      },
    }),
    {
      name: 'psysonic-library-index',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (version < 1) {
          const old = persisted as PersistedV0;
          const masterEnabled = Object.values(old.indexEnabledByServer ?? {}).some(v => v === true);
          return {
            masterEnabled,
            syncExcludedByServer: {},
            autoReconcileEnabled: old.autoReconcileEnabled ?? true,
          };
        }
        return persisted as {
          masterEnabled: boolean;
          syncExcludedByServer: Record<string, boolean>;
          autoReconcileEnabled: boolean;
        };
      },
    },
  ),
);
