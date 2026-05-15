import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PlaylistLayoutItemId =
  | 'addSongs'
  | 'importCsv'
  | 'downloadZip'
  | 'offlineCache'
  | 'suggestions';

export interface PlaylistLayoutItemConfig {
  id: PlaylistLayoutItemId;
  visible: boolean;
}

export const DEFAULT_PLAYLIST_LAYOUT_ITEMS: PlaylistLayoutItemConfig[] = [
  { id: 'addSongs',     visible: true },
  { id: 'importCsv',    visible: true },
  { id: 'downloadZip',  visible: true },
  { id: 'offlineCache', visible: true },
  { id: 'suggestions',  visible: true },
];

interface PlaylistLayoutStore {
  items: PlaylistLayoutItemConfig[];
  setItems: (items: PlaylistLayoutItemConfig[]) => void;
  toggleItem: (id: PlaylistLayoutItemId) => void;
  reset: () => void;
}

export const usePlaylistLayoutStore = create<PlaylistLayoutStore>()(
  persist(
    (set) => ({
      items: DEFAULT_PLAYLIST_LAYOUT_ITEMS,

      setItems: (items) => set({ items }),

      toggleItem: (id) => set((s) => ({
        items: s.items.map(it => it.id === id ? { ...it, visible: !it.visible } : it),
      })),

      reset: () => set({ items: DEFAULT_PLAYLIST_LAYOUT_ITEMS }),
    }),
    {
      name: 'psysonic_playlist_layout',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const knownIds = new Set(DEFAULT_PLAYLIST_LAYOUT_ITEMS.map(i => i.id));
        const safe = (state.items ?? [])
          .filter((i): i is PlaylistLayoutItemConfig =>
            i != null && typeof i.id === 'string' && knownIds.has(i.id as PlaylistLayoutItemId));
        const seen = new Set(safe.map(i => i.id));
        const missing = DEFAULT_PLAYLIST_LAYOUT_ITEMS.filter(i => !seen.has(i.id));
        state.items = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    }
  )
);

export function isPlaylistLayoutCustomized(items: PlaylistLayoutItemConfig[]): boolean {
  if (items.length !== DEFAULT_PLAYLIST_LAYOUT_ITEMS.length) return true;
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const def = DEFAULT_PLAYLIST_LAYOUT_ITEMS[i];
    if (cur.id !== def.id || cur.visible !== def.visible) return true;
  }
  return false;
}
