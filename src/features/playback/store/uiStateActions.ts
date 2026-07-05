import {
  persistQueueVisibility,
} from '@/features/playback/store/queueVisibilityStorage';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import {
  ensurePlaybackServerActive,
  playbackServerDiffersFromActive,
} from '@/features/playback/utils/playback/playbackServer';

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
        // Thin-state: the queue's copy lives in the resolver cache; the override
        // map (merged on read via applyQueueOverrides) drives the queue-row UI.
        return {
          userRatingOverrides: nextOverrides,
          currentTrack:
            s.currentTrack?.id === id ? { ...s.currentTrack, userRating: rating } : s.currentTrack,
        };
      }),

    openContextMenu: (x, y, item, type, queueIndex, playlistId, playlistSongIndex, shareKindOverride, pinToPlaybackServer) => {
      const pin = pinToPlaybackServer ?? type === 'queue-item';
      const open = () =>
        set({
          contextMenu: {
            isOpen: true,
            x,
            y,
            item,
            type,
            queueIndex,
            playlistId,
            playlistSongIndex,
            shareKindOverride,
            pinToPlaybackServer: pin,
          },
        });
      if (pin && playbackServerDiffersFromActive()) {
        void ensurePlaybackServerActive().then(ok => {
          if (ok) open();
        });
        return;
      }
      open();
    },

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
