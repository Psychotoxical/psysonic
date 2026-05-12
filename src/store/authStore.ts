import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { IS_LINUX } from '../utils/platform';
import {
  LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS,
  clampStoredLoudnessPreAnalysisAttenuationRefDb,
} from '../utils/loudnessPreAnalysisSlider';
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
import {
  clampMixFilterMinStars,
  clampRandomMixSize,
  sanitizeLoudnessLufsPreset,
  sanitizeLoudnessPreAnalysisFromStorage,
  sanitizeSkipStarCounts,
} from './authStoreHelpers';
import type {
  AuthState,
  DiscordCoverSource,
  LyricsSourceConfig,
  SeekbarStyle,
} from './authStoreTypes';



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
        // If both hot cache and preload were enabled before mutual exclusion was enforced, reset both.
        const conflictingLegacyState =
          state.hotCacheEnabled && state.preloadMode !== 'off'
            ? { hotCacheEnabled: false, preloadMode: 'off' as const }
            : {};

        // Migrate lyricsServerFirst + enableNeteaselyrics → lyricsSources (one-time).
        let lyricsSourcesMigrated: { lyricsSources?: LyricsSourceConfig[] } = {};
        try {
          const raw = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}') as { state?: Record<string, unknown> };
          if (!raw?.state?.lyricsSources) {
            const serverFirst = (raw?.state?.lyricsServerFirst as boolean | undefined) ?? true;
            const neteaseOn   = (raw?.state?.enableNeteaselyrics as boolean | undefined) ?? false;
            const migrated: LyricsSourceConfig[] = serverFirst
              ? [{ id: 'server', enabled: true }, { id: 'lrclib', enabled: true }, { id: 'netease', enabled: neteaseOn }]
              : [{ id: 'lrclib', enabled: true }, { id: 'server', enabled: true }, { id: 'netease', enabled: neteaseOn }];
            lyricsSourcesMigrated = { lyricsSources: migrated };
          }
        } catch { /* ignore */ }

        // One-time: older builds could persist smooth=false as the default. Force smooth on once
        // so updates do not leave users on discrete scrolling; after this flag exists, only an
        // explicit toggle in Settings may turn it off (persisted in psysonic-auth).
        const wheelSmoothMigrationKey = 'psysonic-linux-webkit-smooth-v1';
        let wheelSmoothOneTime: { linuxWebkitKineticScroll?: boolean } = {};
        if (IS_LINUX) {
          try {
            if (!localStorage.getItem(wheelSmoothMigrationKey)) {
              wheelSmoothOneTime = { linuxWebkitKineticScroll: true };
              localStorage.setItem(wheelSmoothMigrationKey, '1');
            }
          } catch { /* ignore */ }
        }

        // 'waveform' style was renamed to 'truewave' (with 'pseudowave' added
        // as the deterministic legacy variant). Any persisted value that is
        // not a valid SeekbarStyle (legacy 'waveform', undefined, tampered
        // strings) lands on the new bins-based default — otherwise the
        // dispatcher's switch finds no match and the seekbar renders blank.
        const VALID_SEEKBAR_STYLES = new Set<string>([
          'truewave', 'pseudowave', 'linedot', 'bar', 'thick',
          'segmented', 'neon', 'pulsewave', 'particletrail', 'liquidfill', 'retrotape',
        ]);
        const seekbarStyleMigrated = VALID_SEEKBAR_STYLES.has(state.seekbarStyle as string)
          ? {}
          : { seekbarStyle: 'truewave' as SeekbarStyle };

        // The `animationMode` 3-state setting was removed; users on `'reduced'`
        // or `'static'` collapse onto the former `'full'` path automatically as
        // soon as the field is gone from the store. Strip the persisted field
        // so it doesn't sit in localStorage as cruft.
        delete (state as { animationMode?: unknown }).animationMode;
        // The earlier `reducedAnimations: boolean` predecessor likewise loses
        // its meaning; clear it for the same reason.
        delete (state as { reducedAnimations?: unknown }).reducedAnimations;

        const st = state as {
          loudnessTargetLufs?: unknown;
          loudnessPreAnalysisAttenuationDb?: unknown;
          loudnessPreIsRefV1?: unknown;
        };
        const targetSan = sanitizeLoudnessLufsPreset(st.loudnessTargetLufs, -12);
        const rawN = st.loudnessPreAnalysisAttenuationDb;
        const n = typeof rawN === 'number' ? rawN : Number(rawN);
        const preSan =
          st.loudnessPreIsRefV1 === true
            ? sanitizeLoudnessPreAnalysisFromStorage(rawN)
            : (Number.isFinite(n)
                ? clampStoredLoudnessPreAnalysisAttenuationRefDb(
                    n - (targetSan - LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS),
                  )
                : DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB);

        // Migrate enableAppleMusicCoversDiscord boolean → discordCoverSource enum.
        let discordCoverSourceMigrated: { discordCoverSource?: DiscordCoverSource } = {};
        const legacyAppleCovers = (state as { enableAppleMusicCoversDiscord?: unknown }).enableAppleMusicCoversDiscord;
        if (legacyAppleCovers === true && (!state.discordCoverSource || state.discordCoverSource === 'none')) {
          discordCoverSourceMigrated = { discordCoverSource: 'apple' };
        }

        useAuthStore.setState({
          mixMinRatingSong: clampMixFilterMinStars(state.mixMinRatingSong as number),
          mixMinRatingAlbum: clampMixFilterMinStars(state.mixMinRatingAlbum as number),
          mixMinRatingArtist: clampMixFilterMinStars(state.mixMinRatingArtist as number),
          randomMixSize: clampRandomMixSize(state.randomMixSize as number),
          skipStarManualSkipCountsByKey: sanitizeSkipStarCounts(
            (state as { skipStarManualSkipCountsByKey?: unknown }).skipStarManualSkipCountsByKey,
          ),
          loudnessTargetLufs: targetSan,
          loudnessPreAnalysisAttenuationDb: preSan,
          loudnessPreIsRefV1: true,
          ...conflictingLegacyState,
          ...lyricsSourcesMigrated,
          ...wheelSmoothOneTime,
          ...seekbarStyleMigrated,
          ...discordCoverSourceMigrated,
        });
      },
    }
  )
);
