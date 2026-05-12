import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Track-preview settings. `setTrackPreviewStartRatio` clamps to
 * 0…0.9 (preview window can't start past 90% of the track) and
 * `setTrackPreviewDurationSec` clamps to 5…120 seconds.
 */
export function createTrackPreviewActions(set: SetState): Pick<
  AuthState,
  | 'setTrackPreviewsEnabled'
  | 'setTrackPreviewLocation'
  | 'setTrackPreviewStartRatio'
  | 'setTrackPreviewDurationSec'
> {
  return {
    setTrackPreviewsEnabled: (v) => set({ trackPreviewsEnabled: !!v }),
    setTrackPreviewLocation: (location, enabled) => set(state => ({
      trackPreviewLocations: { ...state.trackPreviewLocations, [location]: !!enabled },
    })),
    setTrackPreviewStartRatio: (v) => set({ trackPreviewStartRatio: Math.max(0, Math.min(0.9, v)) }),
    setTrackPreviewDurationSec: (v) => set({ trackPreviewDurationSec: Math.max(5, Math.min(120, Math.round(v))) }),
  };
}
