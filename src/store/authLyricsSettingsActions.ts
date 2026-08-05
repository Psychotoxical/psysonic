import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Lyrics fetch-pipeline settings: source order/enablement, mode
 * and the static-only
 * rendering toggle. Visual lyrics chrome (rail vs apple,
 * fullscreen show/hide) lives in `authUiAppearanceActions.ts`.
 */
export function createLyricsSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setLyricsServerFirst'
  | 'setEnableNeteaselyrics'
  | 'setLyricsSources'
  | 'setLyricsStaticOnly'
> {
  return {
    setLyricsServerFirst: (v) => set({ lyricsServerFirst: v }),
    setEnableNeteaselyrics: (v) => set({ enableNeteaselyrics: v }),
    setLyricsSources: (sources) => set({ lyricsSources: sources }),
    setLyricsStaticOnly: (v) => set({ lyricsStaticOnly: v }),
  };
}
