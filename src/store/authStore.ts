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
  DEFAULT_LIBRARY_GRID_MAX_COLUMNS,
} from './authStoreDefaults';
import { computeAuthStoreRehydration } from './authStoreRehydrate';
import type { AuthState } from './authStoreTypes';
import { getCachedConnectBaseUrl } from '../utils/server/serverEndpoint';
import { serverProfileBaseUrl } from '../utils/server/serverBaseUrl';



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
      coverRevalidateCycleDays: 30,
      coverRevalidateMaxProbesPerSession: 500,
      coverRevalidateMaxProbesPerMinute: 20,
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
      infiniteQueueEnabled: false,
      preservePlayNextOrder: false,
      showArtistImages: false,
      libraryGridMaxColumns: DEFAULT_LIBRARY_GRID_MAX_COLUMNS,
      showTrayIcon: true,
      minimizeToTray: false,
      clockFormat: 'auto',
      showOrbitTrigger: true,
      discordRichPresence: false,
      discordCoverSource: 'server',
      enableBandsintown: false,
      discordTemplateDetails: '{artist}',
      discordTemplateState: '{title}',
      discordTemplateLargeText: '{album}',
      discordTemplateName: '{title}',
      useCustomTitlebar: false,
      preloadMiniPlayer: false,
      linuxWebkitKineticScroll: true,
      linuxWaylandTextRenderProfile: 'sharp',
      linuxWebkitInputForceRepaint: false,
      loggingMode: 'normal',
      nowPlayingEnabled: false,
      lyricsServerFirst: true,
      enableNeteaselyrics: false,
      lyricsSources: DEFAULT_LYRICS_SOURCES,
      youLyPlusEnabled: false,
      lyricsStaticOnly: false,
      sidebarLyricsStyle: 'classic',
      showChangelogOnUpdate: true,
      lastSeenChangelogVersion: '',
      advancedSettingsEnabled: false,
      seekbarStyle: 'truewave',
      queueNowPlayingCollapsed: false,
      queueDurationDisplayMode: 'total',
      queueDisplayMode: 'queue',
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
      nowPlayingAtTop: false,
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
        // Dual-address: read the runtime-probed connect URL from the
        // serverEndpoint cache. `null` (no probe yet — first boot, switch
        // happening right now) falls back to the normalized primary URL so
        // callers running before the first probe still get a usable base.
        const cached = getCachedConnectBaseUrl(server.id);
        if (cached) return cached;
        return serverProfileBaseUrl({ url: server.url });
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
