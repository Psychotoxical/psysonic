import {
  persistQueueVisibility,
} from './queueVisibilityStorage';
import type { PlayerState } from './playerStoreTypes';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;

/**
 * Pure-UI state setters: no audio engine / network side effects.
 * Add new actions here only if they fit that contract.
 */
export function createUiStateActions(set: SetState): Pick<
  PlayerState,
  | 'setStarredOverride'
  | 'setUserRatingOverride'
  | 'openContextMenu'
  | 'closeContextMenu'
  | 'openSongInfo'
  | 'closeSongInfo'
  | 'toggleQueue'
  | 'setQueueVisible'
  | 'toggleFullscreen'
  | 'toggleRepeat'
> {
  return {
    setStarredOverride: (id, starred) =>
      set(s => ({ starredOverrides: { ...s.starredOverrides, [id]: starred } })),

    setUserRatingOverride: (id, rating) =>
      set(s => {
        const nextOverrides = { ...s.userRatingOverrides };
        if (rating === 0) delete nextOverrides[id];
        else nextOverrides[id] = rating;
        return {
          userRatingOverrides: nextOverrides,
          queue: s.queue.map(t => (t.id === id ? { ...t, userRating: rating } : t)),
          currentTrack:
            s.currentTrack?.id === id ? { ...s.currentTrack, userRating: rating } : s.currentTrack,
        };
      }),

    openContextMenu: (x, y, item, type, queueIndex, playlistId, playlistSongIndex, shareKindOverride) =>
      set({
        contextMenu: { isOpen: true, x, y, item, type, queueIndex, playlistId, playlistSongIndex, shareKindOverride },
      }),

    closeContextMenu: () =>
      set(state => ({
        contextMenu: { ...state.contextMenu, isOpen: false },
      })),

    openSongInfo: (songId) => set({ songInfoModal: { isOpen: true, songId } }),
    closeSongInfo: () => set({ songInfoModal: { isOpen: false, songId: null } }),

    toggleQueue: () =>
      set(state => {
        const next = !state.isQueueVisible;
        persistQueueVisibility(next);
        return { isQueueVisible: next };
      }),

    setQueueVisible: (v: boolean) => {
      persistQueueVisibility(v);
      set({ isQueueVisible: v });
    },

    toggleFullscreen: () => set(state => ({ isFullscreenOpen: !state.isFullscreenOpen })),

    toggleRepeat: () =>
      set(state => {
        const modes = ['off', 'all', 'one'] as const;
        return { repeatMode: modes[(modes.indexOf(state.repeatMode) + 1) % modes.length] };
      }),
  };
}
