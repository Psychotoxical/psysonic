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
  | 'setLibraryGridMaxColumns'
  | 'setShowTrayIcon'
  | 'setMinimizeToTray'
  | 'setClockFormat'
  | 'setShowOrbitTrigger'
  | 'setUseCustomTitlebar'
  | 'setPreloadMiniPlayer'
  | 'setLinuxWebkitKineticScroll'
  | 'setLinuxWaylandTextRenderProfile'
  | 'setLinuxWebkitInputForceRepaint'
  | 'setSeekbarStyle'
  | 'setQueueNowPlayingCollapsed'
  | 'setQueueDurationDisplayMode'
  | 'setQueueDisplayMode'
  | 'setShowFullscreenLyrics'
  | 'setFsLyricsStyle'
  | 'setSidebarLyricsStyle'
  | 'setShowFsArtistPortrait'
  | 'setFsPortraitDim'
  | 'setShowChangelogOnUpdate'
  | 'setLastSeenChangelogVersion'
  | 'setAdvancedSettingsEnabled'
> {
  return {
    setShowArtistImages: (v) => set({ showArtistImages: v }),
    setLibraryGridMaxColumns: (v) => set({ libraryGridMaxColumns: clampLibraryGridMaxColumns(v) }),
    setShowTrayIcon: (v) => set({ showTrayIcon: v }),
    setMinimizeToTray: (v) => set({ minimizeToTray: v }),
    setClockFormat: (v) => set({ clockFormat: v }),
    setShowOrbitTrigger: (v) => set({ showOrbitTrigger: v }),
    setUseCustomTitlebar: (v) => set({ useCustomTitlebar: v }),
    setPreloadMiniPlayer: (v) => set({ preloadMiniPlayer: v }),
    setLinuxWebkitKineticScroll: (v) => set({ linuxWebkitKineticScroll: v }),
    setLinuxWaylandTextRenderProfile: (v) => set({ linuxWaylandTextRenderProfile: v }),
    setLinuxWebkitInputForceRepaint: (v) => set({ linuxWebkitInputForceRepaint: v }),
    setSeekbarStyle: (v) => set({ seekbarStyle: v }),
    setQueueNowPlayingCollapsed: (v) => set({ queueNowPlayingCollapsed: v }),
    setQueueDurationDisplayMode: (v) => set({ queueDurationDisplayMode: v }),
    setQueueDisplayMode: (v) => set({ queueDisplayMode: v }),
    setShowFullscreenLyrics: (v) => set({ showFullscreenLyrics: v }),
    setFsLyricsStyle: (v) => set({ fsLyricsStyle: v }),
    setSidebarLyricsStyle: (v) => set({ sidebarLyricsStyle: v }),
    setShowFsArtistPortrait: (v) => set({ showFsArtistPortrait: v }),
    setFsPortraitDim: (v) => set({ fsPortraitDim: v }),
    setShowChangelogOnUpdate: (v) => set({ showChangelogOnUpdate: v }),
    setLastSeenChangelogVersion: (v) => set({ lastSeenChangelogVersion: v }),
    setAdvancedSettingsEnabled: (v) => set({ advancedSettingsEnabled: v }),
  };
}
