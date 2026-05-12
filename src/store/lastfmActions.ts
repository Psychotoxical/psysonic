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
 * Four Last.fm love-related actions, factored out of the playerStore
 * `create()` body so the action set can be tested + reasoned about
 * separately:
 *
 *  - `toggleLastfmLove` — flip the current track's love state on the
 *    server, write through to the local cache map keyed by
 *    `${title}::${artist}` so other queue rows showing the same song
 *    update too.
 *  - `setLastfmLoved` — force-set the boolean (used by the
 *    `track:lastfm-loved` SSE-style event). Updates the cache when a
 *    current track exists.
 *  - `setLastfmLovedForSong` — write the cache for an arbitrary
 *    title/artist pair (used by the QueuePanel love button on
 *    not-yet-current tracks).
 *  - `syncLastfmLovedTracks` — startup-time bulk fetch of the user's
 *    loved-tracks list, merged into the local cache (local likes win
 *    on conflict) plus a recompute of the current track's flag.
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
