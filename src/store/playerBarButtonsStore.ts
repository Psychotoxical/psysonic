import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY,
  mergePlayerBarButtonVisibility,
  type PlayerBarButtonId,
  type PlayerBarButtonVisibility,
} from './playerBarButtonsRehydrate';

export type { PlayerBarButtonId, PlayerBarButtonVisibility } from './playerBarButtonsRehydrate';
export { DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY };

interface PlayerBarButtonsStore {
  visibility: PlayerBarButtonVisibility;
  toggle: (id: PlayerBarButtonId) => void;
  reset: () => void;
}

export const usePlayerBarButtonsStore = create<PlayerBarButtonsStore>()(
  persist(
    (set) => ({
      visibility: { ...DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY },

      toggle: (id) => set((s) => ({
        visibility: { ...s.visibility, [id]: !s.visibility[id] },
      })),

      reset: () => set({ visibility: { ...DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY } }),
    }),
    {
      name: 'psysonic_player_bar_buttons',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.visibility = mergePlayerBarButtonVisibility(state.visibility);
      },
    }
  )
);
