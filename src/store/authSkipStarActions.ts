import {
  clampSkipStarThreshold,
  skipStarCountStorageKey,
} from './authStoreHelpers';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/**
 * Skip-to-1★ feature: after N manual skips of the same track, set
 * its rating to 1 if still unrated. Counter is per
 * `<activeServerId><trackId>` key, persisted in
 * `skipStarManualSkipCountsByKey`, and cleared either when the
 * threshold is crossed (so the next session starts fresh) or when
 * the track ends naturally without a skip.
 *
 * Disabling the feature wipes the counter map so re-enabling later
 * doesn't resume from stale partial counts.
 */
export function createSkipStarActions(set: SetState, get: GetState): Pick<
  AuthState,
  | 'setSkipStarOnManualSkipsEnabled'
  | 'setSkipStarManualSkipThreshold'
  | 'recordSkipStarManualAdvance'
  | 'clearSkipStarManualCountForTrack'
> {
  return {
    setSkipStarOnManualSkipsEnabled: (v) =>
      set({
        skipStarOnManualSkipsEnabled: v,
        ...(v ? {} : { skipStarManualSkipCountsByKey: {} }),
      }),
    setSkipStarManualSkipThreshold: (v) =>
      set({ skipStarManualSkipThreshold: clampSkipStarThreshold(v) }),

    recordSkipStarManualAdvance: (trackId: string) => {
      const s = get();
      if (!s.skipStarOnManualSkipsEnabled || s.skipStarManualSkipThreshold < 1) return null;
      const key = skipStarCountStorageKey(s.activeServerId, trackId);
      const prev = s.skipStarManualSkipCountsByKey[key] ?? 0;
      const threshold = s.skipStarManualSkipThreshold;
      const next = prev + 1;
      if (next >= threshold) {
        const { [key]: _removed, ...rest } = s.skipStarManualSkipCountsByKey;
        set({ skipStarManualSkipCountsByKey: rest });
        return { crossedThreshold: true };
      }
      set({
        skipStarManualSkipCountsByKey: { ...s.skipStarManualSkipCountsByKey, [key]: next },
      });
      return { crossedThreshold: false };
    },

    clearSkipStarManualCountForTrack: (trackId: string) => {
      const s = get();
      const key = skipStarCountStorageKey(s.activeServerId, trackId);
      if (s.skipStarManualSkipCountsByKey[key] === undefined) return;
      const { [key]: _removed, ...rest } = s.skipStarManualSkipCountsByKey;
      set({ skipStarManualSkipCountsByKey: rest });
    },
  };
}
