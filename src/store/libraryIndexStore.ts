import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Settings for the local library index (spec §7.3). Kept out of
 * `authStore` so the persisted blob stays small and the index feature
 * can evolve independently. Per-server enable flag plus the
 * auto-reconcile toggle; threshold stays at the backend default (5 %)
 * in v1 (PR-5c-ui — no UI input yet).
 */
interface LibraryIndexState {
  /** `serverId → enabled`. Absent = off (P6 default). */
  indexEnabledByServer: Record<string, boolean>;
  autoReconcileEnabled: boolean;
  setIndexEnabled: (serverId: string, enabled: boolean) => void;
  setAutoReconcileEnabled: (enabled: boolean) => void;
  isIndexEnabled: (serverId: string | null | undefined) => boolean;
}

export const useLibraryIndexStore = create<LibraryIndexState>()(
  persist(
    (set, get) => ({
      indexEnabledByServer: {},
      autoReconcileEnabled: true,
      setIndexEnabled: (serverId, enabled) =>
        set(s => ({
          indexEnabledByServer: { ...s.indexEnabledByServer, [serverId]: enabled },
        })),
      setAutoReconcileEnabled: enabled => set({ autoReconcileEnabled: enabled }),
      isIndexEnabled: serverId =>
        !!serverId && get().indexEnabledByServer[serverId] === true,
    }),
    {
      name: 'psysonic-library-index',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
