import { offlineActionPolicy } from '@/features/offline/utils/offlineActionPolicy';
import { isOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import { submitTrackScrobble } from '@/features/playback/store/submitTrackScrobble';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

export function createScrobbleActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'forceScrobbleCurrentTrack'
> {
  return {
    forceScrobbleCurrentTrack: () => {
      const { currentTrack, currentRadio, scrobbled, queueItems, queueIndex } = get();
      if (!currentTrack || currentRadio || scrobbled) return false;
      if (!offlineActionPolicy('playerBar', isOfflineBrowseActive()).canScrobble) return false;
      set({ scrobbled: true });
      submitTrackScrobble(currentTrack, queueItems[queueIndex]);
      return true;
    },
  };
}
