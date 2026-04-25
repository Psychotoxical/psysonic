import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type HomeSectionId = 'hero' | 'recent' | 'discover' | 'discoverSongs' | 'discoverArtists' | 'recentlyPlayed' | 'starred' | 'mostPlayed';

export interface HomeSectionConfig {
  id: HomeSectionId;
  visible: boolean;
}

export const DEFAULT_HOME_SECTIONS: HomeSectionConfig[] = [
  { id: 'hero',            visible: true },
  { id: 'recent',          visible: true },
  { id: 'discover',        visible: true },
  { id: 'discoverSongs',   visible: true },
  { id: 'discoverArtists', visible: true },
  { id: 'recentlyPlayed',  visible: true },
  { id: 'starred',         visible: true },
  { id: 'mostPlayed',      visible: true },
];

interface HomeStore {
  sections: HomeSectionConfig[];
  toggleSection: (id: HomeSectionId) => void;
  reset: () => void;
}

export const useHomeStore = create<HomeStore>()(
  persist(
    (set) => ({
      sections: DEFAULT_HOME_SECTIONS,
      toggleSection: (id) => set((s) => ({
        sections: s.sections.map(sec => sec.id === id ? { ...sec, visible: !sec.visible } : sec),
      })),
      reset: () => set({ sections: DEFAULT_HOME_SECTIONS }),
    }),
    {
      name: 'psysonic_home',
      onRehydrateStorage: () => (state) => {
        // Append any sections introduced after the user first persisted their order,
        // so new defaults show up without forcing a manual Reset.
        if (!state) return;
        const safe = (state.sections ?? []).filter(
          (s): s is HomeSectionConfig => s != null && typeof s.id === 'string',
        );
        const known = new Set(safe.map(s => s.id));
        const missing = DEFAULT_HOME_SECTIONS.filter(s => !known.has(s.id));
        state.sections = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    }
  )
);
