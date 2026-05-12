import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Persistent plumbing settings that don't fit a more specific domain:
 * runtime logging level, Navidrome `getNowPlaying` toggle, preload
 * mode + custom seconds, audiobook exclusion, genre blacklist.
 */
export function createPlumbingSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setLoggingMode'
  | 'setNowPlayingEnabled'
  | 'setPreloadMode'
  | 'setPreloadCustomSeconds'
  | 'setExcludeAudiobooks'
  | 'setCustomGenreBlacklist'
> {
  return {
    setLoggingMode: (v) => set({ loggingMode: v }),
    setNowPlayingEnabled: (v) => set({ nowPlayingEnabled: v }),
    setPreloadMode: (v) => set({ preloadMode: v }),
    setPreloadCustomSeconds: (v) => set({ preloadCustomSeconds: v }),
    setExcludeAudiobooks: (v) => set({ excludeAudiobooks: v }),
    setCustomGenreBlacklist: (v) => set({ customGenreBlacklist: v }),
  };
}
