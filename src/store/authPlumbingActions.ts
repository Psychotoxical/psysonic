import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Persistent plumbing settings that don't fit a more specific domain:
 * runtime logging level, Navidrome `getNowPlaying` toggle, audiobook
 * exclusion, genre blacklist.
 */
export function createPlumbingSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setLoggingMode'
  | 'setNowPlayingEnabled'
  | 'setExcludeAudiobooks'
  | 'setCustomGenreBlacklist'
> {
  return {
    setLoggingMode: (v) => set({ loggingMode: v }),
    setNowPlayingEnabled: (v) => set({ nowPlayingEnabled: v }),
    setExcludeAudiobooks: (v) => set({ excludeAudiobooks: v }),
    setCustomGenreBlacklist: (v) => set({ customGenreBlacklist: v }),
  };
}
