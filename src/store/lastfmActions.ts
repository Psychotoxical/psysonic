import {
  lastfmGetAllLovedTracks,
  lastfmLoveTrack,
  lastfmUnloveTrack,
} from '../api/lastfm';
import { useAuthStore } from './authStore';
import type { PlayerState } from './playerStoreTypes';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Four Last.fm love-related actions. The `lastfmLovedCache` is a map
 * keyed by `${title}::${artist}` (not by track id) so other queue rows
 * showing the same song update too when one is loved/unloved.
 * `syncLastfmLovedTracks` merges the server's loved list with local
 * cache — local likes win on conflict.
 */
export function createLastfmActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'toggleLastfmLove' | 'setLastfmLoved' | 'setLastfmLovedForSong' | 'syncLastfmLovedTracks'
> {
  return {
    toggleLastfmLove: () => {
      const { currentTrack, lastfmLoved } = get();
      const { lastfmSessionKey } = useAuthStore.getState();
      if (!currentTrack || !lastfmSessionKey) return;
      const newLoved = !lastfmLoved;
      const cacheKey = `${currentTrack.title}::${currentTrack.artist}`;
      set(s => ({ lastfmLoved: newLoved, lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: newLoved } }));
      if (newLoved) {
        lastfmLoveTrack(currentTrack, lastfmSessionKey);
      } else {
        lastfmUnloveTrack(currentTrack, lastfmSessionKey);
      }
    },

    setLastfmLoved: (v) => {
      const { currentTrack } = get();
      if (currentTrack) {
        const cacheKey = `${currentTrack.title}::${currentTrack.artist}`;
        set(s => ({ lastfmLoved: v, lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: v } }));
      } else {
        set({ lastfmLoved: v });
      }
    },

    syncLastfmLovedTracks: async () => {
      const { lastfmSessionKey, lastfmUsername } = useAuthStore.getState();
      if (!lastfmSessionKey || !lastfmUsername) return;
      const tracks = await lastfmGetAllLovedTracks(lastfmUsername, lastfmSessionKey);
      const newCache: Record<string, boolean> = {};
      for (const t of tracks) newCache[`${t.title}::${t.artist}`] = true;
      // Merge with existing cache (local likes take precedence)
      set(s => ({ lastfmLovedCache: { ...newCache, ...s.lastfmLovedCache } }));
      // Update current track's loved state if it's in the new cache
      const { currentTrack } = get();
      if (currentTrack) {
        const loved = newCache[`${currentTrack.title}::${currentTrack.artist}`] ?? false;
        set({ lastfmLoved: loved });
      }
    },

    setLastfmLovedForSong: (title, artist, v) => {
      const cacheKey = `${title}::${artist}`;
      const isCurrentTrack = get().currentTrack?.title === title && get().currentTrack?.artist === artist;
      set(s => ({
        lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: v },
        ...(isCurrentTrack ? { lastfmLoved: v } : {}),
      }));
    },
  };
}
