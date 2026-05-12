import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Visual / chrome settings. Pure pass-through setters: tray, titlebar,
 * sidebar toggles, fullscreen lyrics rendering options, changelog
 * banner. No side effects.
 */
export function createUiAppearanceActions(set: SetState): Pick<
  AuthState,
  | 'setShowArtistImages'
  | 'setShowTrayIcon'
  | 'setMinimizeToTray'
  | 'setShowOrbitTrigger'
  | 'setUseCustomTitlebar'
  | 'setPreloadMiniPlayer'
  | 'setLinuxWebkitKineticScroll'
  | 'setSeekbarStyle'
  | 'setQueueNowPlayingCollapsed'
  | 'setShowFullscreenLyrics'
  | 'setFsLyricsStyle'
  | 'setSidebarLyricsStyle'
  | 'setShowFsArtistPortrait'
  | 'setFsPortraitDim'
  | 'setShowChangelogOnUpdate'
  | 'setLastSeenChangelogVersion'
> {
  return {
    setShowArtistImages: (v) => set({ showArtistImages: v }),
    setShowTrayIcon: (v) => set({ showTrayIcon: v }),
    setMinimizeToTray: (v) => set({ minimizeToTray: v }),
    setShowOrbitTrigger: (v) => set({ showOrbitTrigger: v }),
    setUseCustomTitlebar: (v) => set({ useCustomTitlebar: v }),
    setPreloadMiniPlayer: (v) => set({ preloadMiniPlayer: v }),
    setLinuxWebkitKineticScroll: (v) => set({ linuxWebkitKineticScroll: v }),
    setSeekbarStyle: (v) => set({ seekbarStyle: v }),
    setQueueNowPlayingCollapsed: (v) => set({ queueNowPlayingCollapsed: v }),
    setShowFullscreenLyrics: (v) => set({ showFullscreenLyrics: v }),
    setFsLyricsStyle: (v) => set({ fsLyricsStyle: v }),
    setSidebarLyricsStyle: (v) => set({ sidebarLyricsStyle: v }),
    setShowFsArtistPortrait: (v) => set({ showFsArtistPortrait: v }),
    setFsPortraitDim: (v) => set({ fsPortraitDim: v }),
    setShowChangelogOnUpdate: (v) => set({ showChangelogOnUpdate: v }),
    setLastSeenChangelogVersion: (v) => set({ lastSeenChangelogVersion: v }),
  };
}
