import type { EntityRatingSupportLevel } from '../api/subsonicTypes';
import type {
  InstantMixProbeResult,
  SubsonicServerIdentity,
} from '../utils/server/subsonicServerIdentity';

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

export type SeekbarStyle = 'truewave' | 'pseudowave' | 'linedot' | 'bar' | 'thick' | 'segmented' | 'neon' | 'pulsewave' | 'particletrail' | 'liquidfill' | 'retrotape';
export type LoggingMode = 'off' | 'normal' | 'debug';
export type NormalizationEngine = 'off' | 'replaygain' | 'loudness';
export type DiscordCoverSource = 'none' | 'apple' | 'server';

/** Integrated-loudness target presets (Settings + analysis). */
export type LoudnessLufsPreset = -16 | -14 | -12 | -10;

export type LyricsSourceId = 'server' | 'lrclib' | 'netease';
export interface LyricsSourceConfig { id: LyricsSourceId; enabled: boolean; }

export type TrackPreviewLocation =
  | 'suggestions'
  | 'albums'
  | 'playlists'
  | 'favorites'
  | 'artist'
  | 'randomMix';

export type TrackPreviewLocations = Record<TrackPreviewLocation, boolean>;

export interface AuthState {
  // Multi-server
  servers: ServerProfile[];
  activeServerId: string | null;

  // Last.fm (global)
  lastfmApiKey: string;
  lastfmApiSecret: string;
  lastfmSessionKey: string;
  lastfmUsername: string;

  // Settings (global)
  scrobblingEnabled: boolean;
  maxCacheMb: number;
  downloadFolder: string;
  offlineDownloadDir: string;
  excludeAudiobooks: boolean;
  customGenreBlacklist: string[];
  replayGainEnabled: boolean;
  normalizationEngine: NormalizationEngine;
  loudnessTargetLufs: LoudnessLufsPreset;
  /**
   * dB extra quieting until loudness is saved, **calibrated for −14 LUFS** target; engine applies
   * `+ (loudnessTargetLufs - (−14))` for other targets. See `effectiveLoudnessPreAnalysisAttenuationDb`.
   */
  loudnessPreAnalysisAttenuationDb: number;
  /** Persisted: stored pre is ref @ −14 (v1+); legacy falsey entries migrate once in onRehydrate. */
  loudnessPreIsRefV1?: boolean;
  replayGainMode: 'track' | 'album' | 'auto';
  replayGainPreGainDb: number;   // added to RG gain for tagged files (0…+6 dB)
  replayGainFallbackDb: number;  // gain for untagged files / radio (-6…0 dB)
  crossfadeEnabled: boolean;
  crossfadeSecs: number;
  gaplessEnabled: boolean;
  /** Show inline Play+Preview buttons in tracklists. Default on per Q3. Master kill switch — when off, all locations are off. */
  trackPreviewsEnabled: boolean;
  /** Per-location toggles. Only honoured when `trackPreviewsEnabled` is true. */
  trackPreviewLocations: TrackPreviewLocations;
  /** Mid-track start position as a 0…1 ratio. Default 0.33 = 33%. */
  trackPreviewStartRatio: number;
  /** Preview window length in seconds. Default 30 s. */
  trackPreviewDurationSec: number;
  preloadMode: 'off' | 'balanced' | 'early' | 'custom';
  preloadCustomSeconds: number;
  infiniteQueueEnabled: boolean;
  preservePlayNextOrder: boolean;
  showArtistImages: boolean;
  showTrayIcon: boolean;
  minimizeToTray: boolean;
  /** Whether the "Orbit" topbar trigger is rendered. Users who never
   *  touch Orbit can hide it so the header stays uncluttered. */
  showOrbitTrigger: boolean;
  discordRichPresence: boolean;
  discordCoverSource: DiscordCoverSource;
  /** Opt-in: fetch upcoming tour dates from Bandsintown for the Now-Playing info panel. */
  enableBandsintown: boolean;
  discordTemplateDetails: string;
  discordTemplateState: string;
  discordTemplateLargeText: string;
  useCustomTitlebar: boolean;
  /** Pre-build the mini-player webview at app start on Linux/macOS so content is available instantly
   *  on first open. Ignored on Windows — that platform always pre-creates as a hang workaround. */
  preloadMiniPlayer: boolean;
  /** Linux WebKitGTK: smooth wheel on when true; off only after explicit opt-out in Settings. */
  linuxWebkitKineticScroll: boolean;
  /** Runtime backend logging level. */
  loggingMode: LoggingMode;
  nowPlayingEnabled: boolean;
  lyricsServerFirst: boolean;
  enableNeteaselyrics: boolean;
  lyricsSources: LyricsSourceConfig[];
  /**
   * `'standard'`  → server + lrclib + netease pipeline (configurable order).
   * `'lyricsplus'` → YouLyPlus / lyricsplus first, silent fallback to standard
   *                  pipeline when no data is returned.
   */
  lyricsMode: 'standard' | 'lyricsplus';
  /**
   * Render synced lines as static text (no auto-scroll, no word highlighting).
   * Honoured in both lyrics modes.
   */
  lyricsStaticOnly: boolean;
  showFullscreenLyrics: boolean;
  /** 'rail' = classic 5-line sliding rail; 'apple' = full-screen scrolling list */
  fsLyricsStyle: 'rail' | 'apple';
  /** Sidebar lyrics scroll style: 'classic' = scrollIntoView center; 'apple' = scroll to 35% */
  sidebarLyricsStyle: 'classic' | 'apple';
  showFsArtistPortrait: boolean;
  /** Portrait dimming 0–100 (percent), applied as CSS rgba alpha */
  fsPortraitDim: number;
  showChangelogOnUpdate: boolean;
  lastSeenChangelogVersion: string;

  seekbarStyle: SeekbarStyle;
  /** Persisted UI toggle: is the Now Playing section in queue panel collapsed */
  queueNowPlayingCollapsed: boolean;

  /** Alpha: native hi-res sample rate output (disabled = safe 44.1 kHz mode) */
  enableHiRes: boolean;
  /** Selected audio output device name. null = system default. */
  audioOutputDevice: string | null;

  /** Alpha: ephemeral queue prefetch cache on disk */
  hotCacheEnabled: boolean;
  hotCacheMaxMb: number;
  hotCacheDebounceSec: number;
  /** Parent directory; actual cache is `<dir>/psysonic-hot-cache/`. Empty = app data. */
  hotCacheDownloadDir: string;

  /** After this many manual skips of the same track, set track rating to 1 if still unrated (below 1 star). */
  skipStarOnManualSkipsEnabled: boolean;
  /** Manual skips per track before applying rating 1 (when enabled). */
  skipStarManualSkipThreshold: number;
  /**
   * Manual Next-count per track for skip→1★. Key = `${serverId}\u001f${trackId}`
   * (empty serverId when none). Persisted; cleared when the track finishes naturally or when threshold is reached.
   */
  skipStarManualSkipCountsByKey: Record<string, number>;
  /** Increment skip count for current server + track; clears stored count when threshold reached. */
  recordSkipStarManualAdvance: (trackId: string) => { crossedThreshold: boolean } | null;
  /** Drop persisted skip count for this track on the active server (e.g. natural playback end). */
  clearSkipStarManualCountForTrack: (trackId: string) => void;

  /** Random mixes, random albums, home hero: drop non‑zero ratings at or below per‑axis thresholds (0 = unrated, kept). */
  mixMinRatingFilterEnabled: boolean;
  /** 0 = ignore; 1–3 = cutoff (UI); exclude track rating r when 0 < r ≤ cutoff. */
  mixMinRatingSong: number;
  /** 0 = ignore; album entity rating from payload or `getAlbum` when missing. */
  mixMinRatingAlbum: number;
  /** 0 = ignore; artist rating from payload / nested OpenSubsonic fields or `getArtist`. */
  mixMinRatingArtist: number;
  /** Random Mix target list size (50, 75, 100, 125, or 150). */
  randomMixSize: number;
  /** Show "Lucky Mix" as a regular sidebar/menu item. */
  showLuckyMixMenu: boolean;

  /** Subsonic music folders for the active server (not persisted; refetched on login / server change). */
  musicFolders: Array<{ id: string; name: string }>;
  /**
   * Per server: `all` = no musicFolderId param; otherwise a single folder id.
   * Only one library or all — no multi-folder merge.
   */
  musicLibraryFilterByServer: Record<string, 'all' | string>;
  /** Bumps when `setMusicLibraryFilter` runs so pages refetch catalog data. */
  musicLibraryFilterVersion: number;

  /**
   * Per server: whether `setRating` is assumed to work for album/artist ids (OpenSubsonic-style).
   * Absent key = not probed yet (`unknown` in UI).
   */
  entityRatingSupportByServer: Record<string, EntityRatingSupportLevel>;
  setEntityRatingSupport: (serverId: string, level: EntityRatingSupportLevel) => void;

  /**
   * Per server: Navidrome has the AudioMuse-AI plugin — use `getSimilarSongs` (Instant Mix) and
   * `getArtistInfo2` similar artists instead of Last.fm for discovery on this server.
   */
  audiomuseNavidromeByServer: Record<string, boolean>;
  setAudiomuseNavidromeEnabled: (serverId: string, enabled: boolean) => void;

  /** From `ping` — used to show the AudioMuse toggle only on Navidrome ≥ 0.60. */
  subsonicServerIdentityByServer: Record<string, SubsonicServerIdentity>;
  setSubsonicServerIdentity: (serverId: string, identity: SubsonicServerIdentity) => void;

  /** Instant Mix / similar path failed while this server had AudioMuse enabled (cleared on success or toggle off). */
  audiomuseNavidromeIssueByServer: Record<string, boolean>;
  setAudiomuseNavidromeIssue: (serverId: string, hasIssue: boolean) => void;

  /**
   * `getSimilarSongs` probe per server (after ping). `empty` hides the AudioMuse row; re-run by testing connection.
   */
  instantMixProbeByServer: Record<string, InstantMixProbeResult>;
  setInstantMixProbe: (serverId: string, result: InstantMixProbeResult) => void;

  // Status
  isLoggedIn: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  lastfmSessionError: boolean;

  // Actions
  addServer: (profile: Omit<ServerProfile, 'id'>) => string;
  updateServer: (id: string, data: Partial<Omit<ServerProfile, 'id'>>) => void;
  removeServer: (id: string) => void;
  setServers: (servers: ServerProfile[]) => void;
  setActiveServer: (id: string) => void;
  setLoggedIn: (v: boolean) => void;
  setConnecting: (v: boolean) => void;
  setConnectionError: (e: string | null) => void;
  setLastfm: (apiKey: string, apiSecret: string, sessionKey: string, username: string) => void;
  connectLastfm: (sessionKey: string, username: string) => void;
  disconnectLastfm: () => void;
  setLastfmSessionError: (v: boolean) => void;
  setScrobblingEnabled: (v: boolean) => void;
  setMaxCacheMb: (v: number) => void;
  setDownloadFolder: (v: string) => void;
  setOfflineDownloadDir: (v: string) => void;
  setExcludeAudiobooks: (v: boolean) => void;
  setCustomGenreBlacklist: (v: string[]) => void;
  setReplayGainEnabled: (v: boolean) => void;
  setNormalizationEngine: (v: NormalizationEngine) => void;
  setLoudnessTargetLufs: (v: LoudnessLufsPreset) => void;
  setLoudnessPreAnalysisAttenuationDb: (v: number) => void;
  resetLoudnessPreAnalysisAttenuationDbDefault: () => void;
  setReplayGainMode: (v: 'track' | 'album' | 'auto') => void;
  setReplayGainPreGainDb: (v: number) => void;
  setReplayGainFallbackDb: (v: number) => void;
  setCrossfadeEnabled: (v: boolean) => void;
  setCrossfadeSecs: (v: number) => void;
  setGaplessEnabled: (v: boolean) => void;
  setTrackPreviewsEnabled: (v: boolean) => void;
  setTrackPreviewLocation: (location: TrackPreviewLocation, enabled: boolean) => void;
  setTrackPreviewStartRatio: (v: number) => void;
  setTrackPreviewDurationSec: (v: number) => void;
  setPreloadMode: (v: 'off' | 'balanced' | 'early' | 'custom') => void;
  setPreloadCustomSeconds: (v: number) => void;
  setInfiniteQueueEnabled: (v: boolean) => void;
  setPreservePlayNextOrder: (v: boolean) => void;
  setShowArtistImages: (v: boolean) => void;
  setShowTrayIcon: (v: boolean) => void;
  setMinimizeToTray: (v: boolean) => void;
  setShowOrbitTrigger: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
  setDiscordCoverSource: (v: DiscordCoverSource) => void;
  setEnableBandsintown: (v: boolean) => void;
  setDiscordTemplateDetails: (v: string) => void;
  setDiscordTemplateState: (v: string) => void;
  setDiscordTemplateLargeText: (v: string) => void;
  setUseCustomTitlebar: (v: boolean) => void;
  setPreloadMiniPlayer: (v: boolean) => void;
  setLinuxWebkitKineticScroll: (v: boolean) => void;
  setLoggingMode: (v: LoggingMode) => void;
  setNowPlayingEnabled: (v: boolean) => void;
  setLyricsServerFirst: (v: boolean) => void;
  setEnableNeteaselyrics: (v: boolean) => void;
  setLyricsSources: (sources: LyricsSourceConfig[]) => void;
  setLyricsMode: (v: 'standard' | 'lyricsplus') => void;
  setLyricsStaticOnly: (v: boolean) => void;
  setShowFullscreenLyrics: (v: boolean) => void;
  setFsLyricsStyle: (v: 'rail' | 'apple') => void;
  setSidebarLyricsStyle: (v: 'classic' | 'apple') => void;
  setShowFsArtistPortrait: (v: boolean) => void;
  setFsPortraitDim: (v: number) => void;
  setShowChangelogOnUpdate: (v: boolean) => void;
  setLastSeenChangelogVersion: (v: string) => void;
  setSeekbarStyle: (v: SeekbarStyle) => void;
  setQueueNowPlayingCollapsed: (v: boolean) => void;
  setEnableHiRes: (v: boolean) => void;
  setAudioOutputDevice: (v: string | null) => void;
  setHotCacheEnabled: (v: boolean) => void;
  setHotCacheMaxMb: (v: number) => void;
  setHotCacheDebounceSec: (v: number) => void;
  setHotCacheDownloadDir: (v: string) => void;
  setSkipStarOnManualSkipsEnabled: (v: boolean) => void;
  setSkipStarManualSkipThreshold: (v: number) => void;
  setMixMinRatingFilterEnabled: (v: boolean) => void;
  setMixMinRatingSong: (v: number) => void;
  setMixMinRatingAlbum: (v: number) => void;
  setMixMinRatingArtist: (v: number) => void;
  setRandomMixSize: (v: number) => void;
  setShowLuckyMixMenu: (v: boolean) => void;
  setMusicFolders: (folders: Array<{ id: string; name: string }>) => void;
  setMusicLibraryFilter: (folderId: 'all' | string) => void;

  /** Navigation style for Mix pages: single hub ('hub') or separate sidebar entries ('separate'). */
  randomNavMode: 'hub' | 'separate';
  setRandomNavMode: (v: 'hub' | 'separate') => void;

  logout: () => void;

  // Derived
  getBaseUrl: () => string;
  getActiveServer: () => ServerProfile | undefined;
}
