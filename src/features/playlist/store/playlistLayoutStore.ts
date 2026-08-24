import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  isPlaylistOwnershipFilter,
  type PlaylistOwnershipFilter,
} from '@/features/playlist/utils/playlistOwnership';
import {
  DEFAULT_PLAYLIST_LIST_SORT,
  isPlaylistListSortKey,
  type PlaylistListSortKey,
} from '@/features/playlist/utils/playlistListSort';

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
  /** Which ownership bucket the Playlists page shows; `all` disables the split. */
  ownershipFilter: PlaylistOwnershipFilter;
  /** Order of the playlist list, shared by the sidebar section and the page. */
  listSortKey: PlaylistListSortKey;
  setItems: (items: PlaylistLayoutItemConfig[]) => void;
  toggleItem: (id: PlaylistLayoutItemId) => void;
  setOwnershipFilter: (filter: PlaylistOwnershipFilter) => void;
  setListSortKey: (key: PlaylistListSortKey) => void;
  reset: () => void;
}

export const usePlaylistLayoutStore = create<PlaylistLayoutStore>()(
  persist(
    (set) => ({
      items: DEFAULT_PLAYLIST_LAYOUT_ITEMS,
      ownershipFilter: 'all',
      listSortKey: DEFAULT_PLAYLIST_LIST_SORT,

      setItems: (items) => set({ items }),

      toggleItem: (id) => set((s) => ({
        items: s.items.map(it => it.id === id ? { ...it, visible: !it.visible } : it),
      })),

      setOwnershipFilter: (ownershipFilter) => set({ ownershipFilter }),

      setListSortKey: (listSortKey) => set({ listSortKey }),

      // Toolbar buttons only. The ownership filter is browse state, not a layout
      // item, so "reset layout" must not silently change which playlists show.
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
        // A value persisted by an older build (or a hand-edited store) must not
        // leave the page stuck on a bucket the control can no longer clear.
        if (!isPlaylistOwnershipFilter(state.ownershipFilter)) state.ownershipFilter = 'all';
        if (!isPlaylistListSortKey(state.listSortKey)) state.listSortKey = DEFAULT_PLAYLIST_LIST_SORT;
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
