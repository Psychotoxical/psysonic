import type { AuthState } from './authStoreTypes';
import { clampLibraryGridMaxColumns } from './authStoreHelpers';

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
  | 'setArtistBrowseCreditMode'
  | 'setLibraryGridMaxColumns'
  | 'setShowTrayIcon'
  | 'setMinimizeToTray'
  | 'setStartMinimizedToTray'
  | 'setClockFormat'
  | 'setShowOrbitTrigger'
  | 'setUseCustomTitlebar'
  | 'setWindowButtonStyle'
  | 'setShowMinimizeButton'
  | 'setPreloadMiniPlayer'
  | 'setLinuxWebkitKineticScroll'
  | 'setLinuxWaylandTextRenderProfile'
  | 'setLinuxWebkitInputForceRepaint'
  | 'setSeekbarStyle'
  | 'setQueueNowPlayingCollapsed'
  | 'setQueueDurationDisplayMode'
  | 'setQueueDisplayMode'
  | 'setSidebarLyricsStyle'
  | 'setShowFullscreenLyrics'
  | 'setFsLyricsStyle'
  | 'setShowFsArtistPortrait'
  | 'setFsPortraitDim'
  | 'setFullscreenPlayerStyle'
  | 'setShowChangelogOnUpdate'
  | 'setLastSeenChangelogVersion'
  | 'setLastDismissedThemeUpdateSig'
  | 'setAdvancedSettingsEnabled'
> {
  return {
    setShowArtistImages: (v) => set({ showArtistImages: v }),
    setArtistBrowseCreditMode: (v) => set({ artistBrowseCreditMode: v === 'track' ? 'track' : 'album' }),
    setLibraryGridMaxColumns: (v) => set({ libraryGridMaxColumns: clampLibraryGridMaxColumns(v) }),
    setShowTrayIcon: (v) => set({
      showTrayIcon: v,
      ...(v ? {} : { startMinimizedToTray: false }),
    }),
    setMinimizeToTray: (v) => set({ minimizeToTray: v }),
    setStartMinimizedToTray: (v) => set((state) => ({
      startMinimizedToTray: v,
      ...(v && !state.showTrayIcon ? { showTrayIcon: true } : {}),
    })),
    setClockFormat: (v) => set({ clockFormat: v }),
    setShowOrbitTrigger: (v) => set({ showOrbitTrigger: v }),
    setUseCustomTitlebar: (v) => set({ useCustomTitlebar: v }),
    setWindowButtonStyle: (v) => set({ windowButtonStyle: v }),
    setShowMinimizeButton: (v) => set({ showMinimizeButton: v }),
    setPreloadMiniPlayer: (v) => set({ preloadMiniPlayer: v }),
    setLinuxWebkitKineticScroll: (v) => set({ linuxWebkitKineticScroll: v }),
    setLinuxWaylandTextRenderProfile: (v) => set({ linuxWaylandTextRenderProfile: v }),
    setLinuxWebkitInputForceRepaint: (v) => set({ linuxWebkitInputForceRepaint: v }),
    setSeekbarStyle: (v) => set({ seekbarStyle: v }),
    setQueueNowPlayingCollapsed: (v) => set({ queueNowPlayingCollapsed: v }),
    setQueueDurationDisplayMode: (v) => set({ queueDurationDisplayMode: v }),
    setQueueDisplayMode: (v) => set({ queueDisplayMode: v }),
    setSidebarLyricsStyle: (v) => set({ sidebarLyricsStyle: v }),
    setShowFullscreenLyrics: (v) => set({ showFullscreenLyrics: v }),
    setFsLyricsStyle: (v) => set({ fsLyricsStyle: v }),
    setShowFsArtistPortrait: (v) => set({ showFsArtistPortrait: v }),
    setFsPortraitDim: (v) => set({ fsPortraitDim: v }),
    setFullscreenPlayerStyle: (v) => set({ fullscreenPlayerStyle: v }),
    setShowChangelogOnUpdate: (v) => set({ showChangelogOnUpdate: v }),
    setLastSeenChangelogVersion: (v) => set({ lastSeenChangelogVersion: v }),
    setLastDismissedThemeUpdateSig: (v) => set({ lastDismissedThemeUpdateSig: v }),
    setAdvancedSettingsEnabled: (v) => set({ advancedSettingsEnabled: v }),
  };
}
