import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createAudioSettingsActions } from './authAudioSettingsActions';
import { createAuthLastfmActions } from './authLastfmActions';
import { createCacheStorageActions } from './authCacheStorageActions';
import { createDiscordSettingsActions } from './authDiscordSettingsActions';
import { createDiscoveryActions } from './authDiscoveryActions';
import { createLyricsSettingsActions } from './authLyricsSettingsActions';
import { createMusicLibraryActions } from './authMusicLibraryActions';
import { createPerServerCapabilityActions } from './authPerServerCapabilityActions';
import { createPlumbingSettingsActions } from './authPlumbingActions';
import { createServerProfileActions } from './authServerProfileActions';
import { createSkipStarActions } from './authSkipStarActions';
import { createTrackPreviewActions } from './authTrackPreviewActions';
import { createUiAppearanceActions } from './authUiAppearanceActions';
import {
  DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
  DEFAULT_LYRICS_SOURCES,
  DEFAULT_TRACK_PREVIEW_LOCATIONS,
} from './authStoreDefaults';
import { computeAuthStoreRehydration } from './authStoreRehydrate';
import type { AuthState } from './authStoreTypes';



export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,
      lastfmApiKey: '',
      lastfmApiSecret: '',
      lastfmSessionKey: '',
      lastfmUsername: '',
      scrobblingEnabled: true,
      maxCacheMb: 500,
      downloadFolder: '',
      offlineDownloadDir: '',
      excludeAudiobooks: false,
      customGenreBlacklist: [],
      replayGainEnabled: false,
      normalizationEngine: 'off',
      loudnessTargetLufs: -12,
      loudnessPreAnalysisAttenuationDb: DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
      loudnessPreIsRefV1: true,
      replayGainMode: 'auto',
      replayGainPreGainDb: 0,
      replayGainFallbackDb: 0,
      crossfadeEnabled: false,
      crossfadeSecs: 3,
      gaplessEnabled: false,
      trackPreviewsEnabled: true,
      trackPreviewLocations: { ...DEFAULT_TRACK_PREVIEW_LOCATIONS },
      trackPreviewStartRatio: 0.33,
      trackPreviewDurationSec: 30,
      preloadMode: 'balanced',
      preloadCustomSeconds: 30,
      infiniteQueueEnabled: false,
      preservePlayNextOrder: false,
      showArtistImages: false,
      showTrayIcon: true,
      minimizeToTray: false,
      showOrbitTrigger: true,
      discordRichPresence: false,
      discordCoverSource: 'server',
      enableBandsintown: false,
      discordTemplateDetails: '{artist}',
      discordTemplateState: '{title}',
      discordTemplateLargeText: '{album}',
      useCustomTitlebar: false,
      preloadMiniPlayer: false,
      linuxWebkitKineticScroll: true,
      loggingMode: 'normal',
      nowPlayingEnabled: false,
      lyricsServerFirst: true,
      enableNeteaselyrics: false,
      lyricsSources: DEFAULT_LYRICS_SOURCES,
      lyricsMode: 'standard',
      lyricsStaticOnly: false,
      showFullscreenLyrics: true,
      fsLyricsStyle: 'rail',
      sidebarLyricsStyle: 'classic',
      showFsArtistPortrait: true,
      fsPortraitDim: 28,
      showChangelogOnUpdate: true,
      lastSeenChangelogVersion: '',
      seekbarStyle: 'truewave',
      queueNowPlayingCollapsed: false,
      enableHiRes: false,
      audioOutputDevice: null,
      hotCacheEnabled: false,
      hotCacheMaxMb: 256,
      hotCacheDebounceSec: 30,
      hotCacheDownloadDir: '',
      skipStarOnManualSkipsEnabled: false,
      skipStarManualSkipThreshold: 3,
      skipStarManualSkipCountsByKey: {},
      mixMinRatingFilterEnabled: false,
      mixMinRatingSong: 0,
      mixMinRatingAlbum: 0,
      mixMinRatingArtist: 0,
      randomMixSize: 50,
      showLuckyMixMenu: true,
      randomNavMode: 'hub',
      musicFolders: [],
      musicLibraryFilterByServer: {},
      musicLibraryFilterVersion: 0,
      entityRatingSupportByServer: {},
      audiomuseNavidromeByServer: {},
      subsonicServerIdentityByServer: {},
      audiomuseNavidromeIssueByServer: {},
      instantMixProbeByServer: {},
      isLoggedIn: false,
      isConnecting: false,
      connectionError: null,
      lastfmSessionError: false,

      ...createServerProfileActions(set),
      ...createAuthLastfmActions(set),
      ...createAudioSettingsActions(set),
      ...createCacheStorageActions(set),
      ...createDiscordSettingsActions(set),
      ...createUiAppearanceActions(set),
      ...createLyricsSettingsActions(set),
      ...createTrackPreviewActions(set),
      ...createDiscoveryActions(set),
      ...createPlumbingSettingsActions(set),
      ...createSkipStarActions(set, get),
      ...createMusicLibraryActions(set, get),
      ...createPerServerCapabilityActions(set),

      getBaseUrl: () => {
        const s = get();
        const server = s.servers.find(srv => srv.id === s.activeServerId);
        if (!server?.url) return '';
        const base = server.url.startsWith('http') ? server.url : `http://${server.url}`;
        return base.replace(/\/$/, '');
      },

      getActiveServer: () => {
        const s = get();
        return s.servers.find(srv => srv.id === s.activeServerId);
      },
    }),
    {
      name: 'psysonic-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: state => {
        const { musicFolders: _mf, musicLibraryFilterVersion: _fv, ...rest } = state;
        return rest;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        useAuthStore.setState(computeAuthStoreRehydration(state));
      },
    }
  )
);
