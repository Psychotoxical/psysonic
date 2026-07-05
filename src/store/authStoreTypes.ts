import type { HiResCrossfadeResampleHz } from '@/lib/audio/hiResCrossfadeResample';
import type { EntityRatingSupportLevel } from '@/lib/api/subsonicTypes';
import type {
  AudiomusePluginProbeResult,
  InstantMixProbeResult,
  SubsonicServerIdentity,
} from '@/lib/server/subsonicServerIdentity';
import type { PersistedAccount } from '../music-network';

/** Album-artist vs track-performer browse (#1209). Duplicated here — not `@/lib/api/library` — to avoid store ↔ library import cycles (dependency-cruiser). */
export type ArtistBrowseCreditMode = 'album' | 'track';

export type CustomHeaderEntry = {
  name: string;
  value: string;
};

export type CustomHeadersApplyTo = 'local' | 'public' | 'both';

export type CustomHeadersFieldError = {
  index: number;
  field: 'name' | 'value';
  messageKey: string;
};

export type CustomHeadersValidationResult =
  | { ok: true }
  | { ok: false; fieldErrors: CustomHeadersFieldError[]; formMessage?: string };

export interface ServerProfile {
  id: string;
  name: string;
  /**
   * Primary address. **Canonical source of the index key** — adding or changing
   * `alternateUrl` never touches library/cover/analysis storage. Only editing
   * `url` (host/port/path) triggers an index-key remigration.
   */
  url: string;
  /**
   * Optional second address (typically a LAN counterpart of a public `url`, or
   * vice versa). Used by the connect layer as a sequential fallback and by the
   * share layer when `shareUsesLocalUrl` flips. Never participates in the index
   * key.
   */
  alternateUrl?: string;
  /**
   * When both `url` and `alternateUrl` are set, controls which one is embedded
   * in Orbit / entity / magic-string shares. Default behaviour (absent / false)
   * is to prefer the **public** address.
   */
  shareUsesLocalUrl?: boolean;
  username: string;
  password: string;
  /** Optional HTTP headers for reverse-proxy gates (Pangolin, Cloudflare Access). */
  customHeaders?: CustomHeaderEntry[];
  /** Which profile endpoint(s) receive `customHeaders`. Default when absent: `'public'`. */
  customHeadersApplyTo?: CustomHeadersApplyTo;
}

export type SeekbarStyle = 'truewave' | 'pseudowave' | 'linedot' | 'bar' | 'thick' | 'segmented' | 'neon' | 'pulsewave' | 'particletrail' | 'liquidfill' | 'retrotape';
/**
 * Look of the custom-title-bar window buttons (minimize/maximize/close).
 * Form-descriptive names, not OS brands:
 * - `dots`: coloured traffic-light circles, glyphs appear on hover (default).
 * - `dotsGlyph`: traffic-light circles with always-visible glyphs (colour + shape).
 * - `flat`: full-height rectangular buttons with line glyphs, red close hover.
 * - `pill`: soft circular monochrome buttons with glyphs.
 * - `outline`: square bordered buttons with thin glyphs, accent hover.
 * - `glyph`: themed monochrome glyphs only, no background — blends with the app.
 */
export type WindowButtonStyle = 'dots' | 'dotsGlyph' | 'flat' | 'pill' | 'outline' | 'glyph';
/** Queue header duration chip: total duration / time left / ETA finish clock. */
export type DurationMode = 'total' | 'remaining' | 'eta';

/**
 * Queue panel render mode.
 * - `playlist`: the full queue stays visible; the now-playing row sits at the
 *   top of the list, the highlight wanders down as tracks play, and the list
 *   only re-pins the current track once it scrolls out of view.
 * - `queue`: the list shows upcoming tracks only — the current track lives in
 *   the header and drops out of the list once it has played.
 */
export type QueueDisplayMode = 'playlist' | 'queue' | 'timeline';
export type LoggingMode = 'off' | 'normal' | 'debug';
/**
 * Wall-clock format for ETA / sleep-timer labels. `'auto'` follows the user's
 * system locale (existing behaviour); explicit `'24h'` / `'12h'` overrides it.
 */
export type ClockFormat = 'auto' | '24h' | '12h';
export type NormalizationEngine = 'off' | 'replaygain' | 'loudness';
export type DiscordCoverSource = 'none' | 'apple' | 'server';
/** Wayland + WebKit text/GPU profile (Settings → System, Linux only when available). */
export type LinuxWaylandTextRenderProfile = 'balanced' | 'sharp' | 'gpu' | 'minimal';

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
  // DiscordBanner
  discordBannerDismissed: boolean;
  discordBannerAccumulatedUsageMs: number;
  dismissDiscordBanner: () => void;
  addDiscordBannerUsageMs: (deltaMs: number) => void;
  
  // Multi-server
  servers: ServerProfile[];
  activeServerId: string | null;

  // Music Network — multi-provider scrobble/enrichment framework state.
  musicNetworkAccounts: PersistedAccount[];
  enrichmentPrimaryId: string | null;
  scrobblingMasterEnabled: boolean;

  // Settings (global)
  maxCacheMb: number;
  coverRevalidateCycleDays: number;
  coverRevalidateMaxProbesPerSession: number;
  coverRevalidateMaxProbesPerMinute: number;
  downloadFolder: string;
  offlineDownloadDir: string;
  /** Unified local playback root `M` (replaces hot/offline dir pickers). */
  mediaDir: string;
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
  /**
   * When crossfading, trim trailing silence of the outgoing track and leading
   * silence of the incoming one so the fade overlaps music, not dead air.
   * Default off — existing installs without this field keep today's behaviour.
   */
  crossfadeTrimSilence: boolean;
  /**
   * AutoDJ: fade out the outgoing track briefly on manual next/previous while
   * playing (avoids an abrupt cut). Default on for new installs.
   */
  autodjSmoothSkip: boolean;
  /**
   * AutoDJ: upper bound for content-driven overlap. `auto` keeps the built-in
   * 12 s cap; `limit` uses `autodjOverlapCapSec` (2–30 s, default 15).
   */
  autodjOverlapCapMode: 'auto' | 'limit';
  autodjOverlapCapSec: number;
  gaplessEnabled: boolean;
  /** Show inline Play+Preview buttons in tracklists. Default on per Q3. Master kill switch — when off, all locations are off. */
  trackPreviewsEnabled: boolean;
  /** Per-location toggles. Only honoured when `trackPreviewsEnabled` is true. */
  trackPreviewLocations: TrackPreviewLocations;
  /** Mid-track start position as a 0…1 ratio. Default 0.33 = 33%. */
  trackPreviewStartRatio: number;
  /** Preview window length in seconds. Default 30 s. */
  trackPreviewDurationSec: number;
  infiniteQueueEnabled: boolean;
  preservePlayNextOrder: boolean;
  showArtistImages: boolean;
  /** Artists browse: album artists vs track performers (#1209). Persisted across sessions. */
  artistBrowseCreditMode: ArtistBrowseCreditMode;
  /**
   * Max columns for album/artist/playlist-style card grids (Settings → Library).
   * Clamped 4…12; higher values mean more tiles per row and more layout/paint work.
   */
  libraryGridMaxColumns: number;
  showTrayIcon: boolean;
  minimizeToTray: boolean;
  clockFormat: ClockFormat;
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
  /** Template for Discord activity name (overrides the registered application
   *  name in the user list / collapsed presence). Default "{title}".
   *  Empty string falls back to "Psysonic". */
  discordTemplateName: string;
  useCustomTitlebar: boolean;
  /** Look of the custom-title-bar window buttons (Linux custom title bar only). */
  windowButtonStyle: WindowButtonStyle;
  /** Show the minimize button in the custom title bar. Off = only maximize + close. */
  showMinimizeButton: boolean;
  /** Pre-build the mini-player webview at app start on Linux/macOS so content is available instantly
   *  on first open. Ignored on Windows — that platform always pre-creates as a hang workaround. */
  preloadMiniPlayer: boolean;
  /** Linux WebKitGTK: smooth wheel on when true; off only after explicit opt-out in Settings. */
  linuxWebkitKineticScroll: boolean;
  /** Linux Wayland + GPU compositing: WebKit text rasterisation profile (live, no restart). */
  linuxWaylandTextRenderProfile: LinuxWaylandTextRenderProfile;
  /** Linux WebKitGTK 2.50.x text-input repaint hang workaround (issues #342, #782).
   *  When true, toggles a one-frame transform on the focused input's parent so WebKit
   *  re-evaluates the layer tree. Off by default — the side-effect is a brief flicker
   *  on focus, accepted trade-off for the affected users. */
  linuxWebkitInputForceRepaint: boolean;
  /** Runtime backend logging level. */
  loggingMode: LoggingMode;
  nowPlayingEnabled: boolean;
  lyricsServerFirst: boolean;
  enableNeteaselyrics: boolean;
  lyricsSources: LyricsSourceConfig[];
  /**
   * YouLyPlus (karaoke) as the primary lyrics source. When on, it is tried
   * first and the enabled `lyricsSources` act as fallback; when off, only the
   * enabled `lyricsSources` are used. Independent of the source toggles, so all
   * lyrics can be turned off (YouLyPlus off + every source off).
   */
  youLyPlusEnabled: boolean;
  /**
   * Render synced lines as static text (no auto-scroll, no word highlighting).
   * Honoured in both lyrics modes.
   */
  lyricsStaticOnly: boolean;
  /** Sidebar lyrics scroll style: 'classic' = scrollIntoView center; 'apple' = scroll to 35% */
  sidebarLyricsStyle: 'classic' | 'apple';
  showChangelogOnUpdate: boolean;
  lastSeenChangelogVersion: string;
  /** Signature of the installed-theme updates last dismissed in the sidebar
   *  notice; the notice reappears once a new update changes the signature. */
  lastDismissedThemeUpdateSig: string;
  /** Reveals sub-sections marked `advanced` across all Settings tabs. */
  advancedSettingsEnabled: boolean;

  seekbarStyle: SeekbarStyle;
  /** Persisted UI toggle: is the Now Playing section in queue panel collapsed */
  queueNowPlayingCollapsed: boolean;
  /** Queue header duration chip mode (cycle: total → remaining → ETA). */
  queueDurationDisplayMode: DurationMode;
  /** Queue panel render mode: full list from top (`playlist`), upcoming-only
   *  (`queue`), or full list centered on the current track with history above
   *  and up-next below (`timeline`). */
  queueDisplayMode: QueueDisplayMode;

  /** Alpha: native hi-res sample rate output (disabled = safe 44.1 kHz mode) */
  enableHiRes: boolean;
  /** Hi-Res: common output rate for crossfade / AutoDJ when adjacent tracks differ (Hz). */
  hiResCrossfadeResampleHz: HiResCrossfadeResampleHz;
  /** Selected audio output device name. null = system default. */
  audioOutputDevice: string | null;

  /** Auto-download starred favorites into `media/favorites/` (separate from offline library). */
  favoritesOfflineEnabled: boolean;

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
   * Legacy single-select; kept in sync with `musicLibrarySelectionByServer` for old readers.
   */
  musicLibraryFilterByServer: Record<string, 'all' | string>;
  /**
   * Per server: ordered library folder ids (index 0 = highest priority).
   * Empty array or absent key = all libraries on that server.
   */
  musicLibrarySelectionByServer: Record<string, string[]>;
  /** Bumps when the music library filter/selection changes so pages refetch catalog data. */
  musicLibraryFilterVersion: number;

  /**
   * Per server: whether `setRating` is assumed to work for album/artist ids (OpenSubsonic-style).
   * Absent key = not probed yet (`unknown` in UI).
   */
  entityRatingSupportByServer: Record<string, EntityRatingSupportLevel>;
  setEntityRatingSupport: (serverId: string, level: EntityRatingSupportLevel) => void;

  /**
   * Per server: AudioMuse-AI features active — manual opt-in on pre-0.62 Navidrome; auto-set on
   * 0.62+ when `sonicSimilarity` probe is `present`. Uses `getSimilarSongs` (Instant Mix) and
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
   * `getSimilarSongs` probe per server (after ping). `empty` hides the AudioMuse row on pre-0.62 Navidrome.
   */
  instantMixProbeByServer: Record<string, InstantMixProbeResult>;
  setInstantMixProbe: (serverId: string, result: InstantMixProbeResult) => void;

  /**
   * Navidrome ≥ 0.62: `sonicSimilarity` extension probe (`present` = AudioMuse-style plugin active).
   */
  audiomusePluginProbeByServer: Record<string, AudiomusePluginProbeResult>;
  setAudiomusePluginProbe: (serverId: string, result: AudiomusePluginProbeResult) => void;

  /**
   * Full OpenSubsonic extension list per server (from `getOpenSubsonicExtensions`).
   * One probe answers every extension-gated feature (AudioMuse `sonicSimilarity`,
   * `playbackReport`, …) instead of re-fetching per feature. Cleared on a server
   * generation change so the next probe repopulates it.
   */
  openSubsonicExtensionsByServer: Record<string, string[]>;
  setOpenSubsonicExtensions: (serverId: string, extensions: string[]) => void;

  // Status
  isLoggedIn: boolean;
  isConnecting: boolean;
  connectionError: string | null;

  // Actions
  addServer: (profile: Omit<ServerProfile, 'id'>) => string;
  updateServer: (id: string, data: Partial<Omit<ServerProfile, 'id'>>) => void;
  removeServer: (id: string) => void;
  setServers: (servers: ServerProfile[]) => void;
  setActiveServer: (id: string) => void;
  setLoggedIn: (v: boolean) => void;
  setConnecting: (v: boolean) => void;
  setConnectionError: (e: string | null) => void;

  // Music Network actions (backing the runtime's MusicNetworkStore port).
  setMusicNetworkAccounts: (accounts: PersistedAccount[]) => void;
  setEnrichmentPrimaryId: (id: string | null) => void;
  setScrobblingMasterEnabled: (v: boolean) => void;
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
  setCrossfadeTrimSilence: (v: boolean) => void;
  setAutodjSmoothSkip: (v: boolean) => void;
  setAutodjOverlapCapMode: (v: 'auto' | 'limit') => void;
  setAutodjOverlapCapSec: (v: number) => void;
  setGaplessEnabled: (v: boolean) => void;
  setTrackPreviewsEnabled: (v: boolean) => void;
  setTrackPreviewLocation: (location: TrackPreviewLocation, enabled: boolean) => void;
  setTrackPreviewStartRatio: (v: number) => void;
  setTrackPreviewDurationSec: (v: number) => void;
  setInfiniteQueueEnabled: (v: boolean) => void;
  setPreservePlayNextOrder: (v: boolean) => void;
  setShowArtistImages: (v: boolean) => void;
  setArtistBrowseCreditMode: (v: ArtistBrowseCreditMode) => void;
  setLibraryGridMaxColumns: (v: number) => void;
  setShowTrayIcon: (v: boolean) => void;
  setMinimizeToTray: (v: boolean) => void;
  setClockFormat: (v: ClockFormat) => void;
  setShowOrbitTrigger: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
  setDiscordCoverSource: (v: DiscordCoverSource) => void;
  setEnableBandsintown: (v: boolean) => void;
  setDiscordTemplateDetails: (v: string) => void;
  setDiscordTemplateState: (v: string) => void;
  setDiscordTemplateLargeText: (v: string) => void;
  setDiscordTemplateName: (v: string) => void;
  setUseCustomTitlebar: (v: boolean) => void;
  setWindowButtonStyle: (v: WindowButtonStyle) => void;
  setShowMinimizeButton: (v: boolean) => void;
  setPreloadMiniPlayer: (v: boolean) => void;
  setLinuxWebkitKineticScroll: (v: boolean) => void;
  setLinuxWaylandTextRenderProfile: (v: LinuxWaylandTextRenderProfile) => void;
  setLinuxWebkitInputForceRepaint: (v: boolean) => void;
  setLoggingMode: (v: LoggingMode) => void;
  setNowPlayingEnabled: (v: boolean) => void;
  setLyricsServerFirst: (v: boolean) => void;
  setEnableNeteaselyrics: (v: boolean) => void;
  setLyricsSources: (sources: LyricsSourceConfig[]) => void;
  setYouLyPlusEnabled: (v: boolean) => void;
  setLyricsStaticOnly: (v: boolean) => void;
  setSidebarLyricsStyle: (v: 'classic' | 'apple') => void;
  setShowChangelogOnUpdate: (v: boolean) => void;
  setLastSeenChangelogVersion: (v: string) => void;
  setLastDismissedThemeUpdateSig: (v: string) => void;
  setAdvancedSettingsEnabled: (v: boolean) => void;
  setSeekbarStyle: (v: SeekbarStyle) => void;
  setQueueNowPlayingCollapsed: (v: boolean) => void;
  setQueueDurationDisplayMode: (v: DurationMode) => void;
  setQueueDisplayMode: (v: QueueDisplayMode) => void;
  setEnableHiRes: (v: boolean) => void;
  setHiResCrossfadeResampleHz: (v: HiResCrossfadeResampleHz) => void;
  setAudioOutputDevice: (v: string | null) => void;
  setFavoritesOfflineEnabled: (v: boolean) => void;
  setHotCacheEnabled: (v: boolean) => void;
  setHotCacheMaxMb: (v: number) => void;
  setHotCacheDebounceSec: (v: number) => void;
  setHotCacheDownloadDir: (v: string) => void;
  setMediaDir: (v: string) => void;
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
  /** Ordered multi-library selection for the active server; array order is priority. */
  setMusicLibrarySelection: (libraryIds: string[]) => void;

  /** Navigation style for Mix pages: single hub ('hub') or separate sidebar entries ('separate'). */
  randomNavMode: 'hub' | 'separate';
  setRandomNavMode: (v: 'hub' | 'separate') => void;

  /** Pin the fixed "Now Playing" sidebar entry to the top instead of the bottom. */
  nowPlayingAtTop: boolean;
  setNowPlayingAtTop: (v: boolean) => void;

  logout: () => void;

  // Derived
  getBaseUrl: () => string;
  getActiveServer: () => ServerProfile | undefined;
}
