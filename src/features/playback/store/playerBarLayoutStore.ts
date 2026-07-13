import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PlayerBarLayoutItemId =
  | 'stop'
  | 'starRating'
  | 'favorite'
  // 'lastfmLove' is the enrichment-primary love button. The id is kept (not
  // renamed to 'networkLove') because it is persisted in user layouts — renaming
  // would silently drop the button from existing configs. Label is provider-neutral.
  | 'lastfmLove'
  | 'playbackRate'
  | 'equalizer'
  | 'miniPlayer';

/**
 * Which cluster of the bar an item lives in.
 *
 * `transport` items sit among the fixed playback controls, so only their
 * visibility is configurable — their position is dictated by the transport row
 * (the play button is a centred, special-cased element; letting users shuffle
 * controls around it buys nothing and breaks the adaptive small-window layout).
 * `actions` items are a plain right-hand row, so they are both toggleable and
 * reorderable.
 */
export type PlayerBarLayoutZone = 'transport' | 'actions';

export const PLAYER_BAR_LAYOUT_ZONES: Record<PlayerBarLayoutItemId, PlayerBarLayoutZone> = {
  stop:         'transport',
  starRating:   'actions',
  favorite:     'actions',
  lastfmLove:   'actions',
  playbackRate: 'actions',
  equalizer:    'actions',
  miniPlayer:   'actions',
};

/** What the track-info block shows under the title. */
export type PlayerBarTrackInfoMode = 'title' | 'titleAlbum';

export const PLAYER_BAR_TRACK_INFO_MODES: PlayerBarTrackInfoMode[] = ['title', 'titleAlbum'];

export interface PlayerBarLayoutItemConfig {
  id: PlayerBarLayoutItemId;
  visible: boolean;
}

export const DEFAULT_PLAYER_BAR_LAYOUT_ITEMS: PlayerBarLayoutItemConfig[] = [
  { id: 'stop',        visible: true },
  { id: 'starRating',  visible: true },
  { id: 'favorite',    visible: true },
  { id: 'lastfmLove',  visible: true },
  { id: 'playbackRate', visible: true },
  { id: 'equalizer',   visible: true },
  { id: 'miniPlayer',  visible: true },
];

export const DEFAULT_PLAYER_BAR_TRACK_INFO_MODE: PlayerBarTrackInfoMode = 'title';

interface PlayerBarLayoutStore {
  items: PlayerBarLayoutItemConfig[];
  trackInfoMode: PlayerBarTrackInfoMode;
  setItems: (items: PlayerBarLayoutItemConfig[]) => void;
  toggleItem: (id: PlayerBarLayoutItemId) => void;
  setTrackInfoMode: (mode: PlayerBarTrackInfoMode) => void;
  reset: () => void;
}

export const usePlayerBarLayoutStore = create<PlayerBarLayoutStore>()(
  persist(
    (set) => ({
      items: DEFAULT_PLAYER_BAR_LAYOUT_ITEMS,
      trackInfoMode: DEFAULT_PLAYER_BAR_TRACK_INFO_MODE,

      setItems: (items) => set({ items }),

      toggleItem: (id) => set((s) => ({
        items: s.items.map(it => it.id === id ? { ...it, visible: !it.visible } : it),
      })),

      setTrackInfoMode: (trackInfoMode) => set({ trackInfoMode }),

      reset: () => set({
        items: DEFAULT_PLAYER_BAR_LAYOUT_ITEMS,
        trackInfoMode: DEFAULT_PLAYER_BAR_TRACK_INFO_MODE,
      }),
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
        // Items added in a later version (e.g. 'stop') are absent from an older
        // stored layout — append them with their default so the button does not
        // silently vanish for existing users.
        const missing = DEFAULT_PLAYER_BAR_LAYOUT_ITEMS.filter(i => !seen.has(i.id));
        state.items = missing.length > 0 ? [...safe, ...missing] : safe;
        if (!PLAYER_BAR_TRACK_INFO_MODES.includes(state.trackInfoMode)) {
          state.trackInfoMode = DEFAULT_PLAYER_BAR_TRACK_INFO_MODE;
        }
      },
    }
  )
);
