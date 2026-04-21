import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ArtistSectionId = 'bio' | 'topTracks' | 'similar' | 'albums' | 'featured';

export interface ArtistSectionConfig {
  id: ArtistSectionId;
  visible: boolean;
}

/**
 * Default order matches the historical layout of `pages/ArtistDetail.tsx` so
 * existing users see no change until they explicitly customise it.
 */
export const DEFAULT_ARTIST_SECTIONS: ArtistSectionConfig[] = [
  { id: 'bio',       visible: true },
  { id: 'topTracks', visible: true },
  { id: 'similar',   visible: true },
  { id: 'albums',    visible: true },
  { id: 'featured',  visible: true },
];

interface ArtistLayoutStore {
  sections: ArtistSectionConfig[];
  setSections: (sections: ArtistSectionConfig[]) => void;
  toggleSection: (id: ArtistSectionId) => void;
  reset: () => void;
}

export const useArtistLayoutStore = create<ArtistLayoutStore>()(
  persist(
    (set) => ({
      sections: DEFAULT_ARTIST_SECTIONS,

      setSections: (sections) => set({ sections }),

      toggleSection: (id) => set((s) => ({
        sections: s.sections.map(sec => sec.id === id ? { ...sec, visible: !sec.visible } : sec),
      })),

      reset: () => set({ sections: DEFAULT_ARTIST_SECTIONS }),
    }),
    {
      name: 'psysonic_artist_layout',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Sanitize: drop null/corrupt entries, append any new sections that
        // were added in a later release so they don't silently disappear.
        const knownIds = new Set(DEFAULT_ARTIST_SECTIONS.map(s => s.id));
        const safe = (state.sections ?? [])
          .filter((s): s is ArtistSectionConfig => s != null && typeof s.id === 'string' && knownIds.has(s.id as ArtistSectionId));
        const seen = new Set(safe.map(s => s.id));
        const missing = DEFAULT_ARTIST_SECTIONS.filter(s => !seen.has(s.id));
        state.sections = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    }
  )
);
