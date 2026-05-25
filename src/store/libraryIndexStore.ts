import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Settings for the local library index (spec §7.3).
 * Index is always on for configured servers; sync controls live under Settings → Servers.
 */
interface LibraryIndexState {
  /** Always true (kept for persisted-state migration and existing call sites). */
  masterEnabled: boolean;
  isIndexEnabled: (serverId: string | null | undefined) => boolean;
  indexedServerIds: (allServerIds: string[]) => string[];
}

export const useLibraryIndexStore = create<LibraryIndexState>()(
  persist(
    (_set, get) => ({
      masterEnabled: true,
      isIndexEnabled: serverId => !!serverId && get().masterEnabled,
      indexedServerIds: allServerIds => (get().masterEnabled ? allServerIds : []),
    }),
    {
      name: 'psysonic-library-index',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, _version) => {
        const previous = persisted as { masterEnabled?: boolean } | undefined;
        return { masterEnabled: previous?.masterEnabled ?? true };
      },
    },
  ),
);
