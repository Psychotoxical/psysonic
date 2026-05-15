import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PlayerBarLayoutItemId =
  | 'starRating'
  | 'favorite'
  | 'lastfmLove'
  | 'equalizer'
  | 'miniPlayer';

export interface PlayerBarLayoutItemConfig {
  id: PlayerBarLayoutItemId;
  visible: boolean;
}

export const DEFAULT_PLAYER_BAR_LAYOUT_ITEMS: PlayerBarLayoutItemConfig[] = [
  { id: 'starRating',  visible: true },
  { id: 'favorite',    visible: true },
  { id: 'lastfmLove',  visible: true },
  { id: 'equalizer',   visible: true },
  { id: 'miniPlayer',  visible: true },
];

interface PlayerBarLayoutStore {
  items: PlayerBarLayoutItemConfig[];
  setItems: (items: PlayerBarLayoutItemConfig[]) => void;
  toggleItem: (id: PlayerBarLayoutItemId) => void;
  reset: () => void;
}

export const usePlayerBarLayoutStore = create<PlayerBarLayoutStore>()(
  persist(
    (set) => ({
      items: DEFAULT_PLAYER_BAR_LAYOUT_ITEMS,

      setItems: (items) => set({ items }),

      toggleItem: (id) => set((s) => ({
        items: s.items.map(it => it.id === id ? { ...it, visible: !it.visible } : it),
      })),

      reset: () => set({ items: DEFAULT_PLAYER_BAR_LAYOUT_ITEMS }),
    }),
    {
      name: 'psysonic_player_bar_layout',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const knownIds = new Set(DEFAULT_PLAYER_BAR_LAYOUT_ITEMS.map(i => i.id));
        const safe = (state.items ?? [])
          .filter((i): i is PlayerBarLayoutItemConfig =>
            i != null && typeof i.id === 'string' && knownIds.has(i.id as PlayerBarLayoutItemId));
        const seen = new Set(safe.map(i => i.id));
        const missing = DEFAULT_PLAYER_BAR_LAYOUT_ITEMS.filter(i => !seen.has(i.id));
        state.items = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    }
  )
);
