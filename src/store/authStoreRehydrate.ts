import { IS_LINUX } from '@/lib/util/platform';
import { sanitizeHiResCrossfadeResampleHz } from '@/lib/audio/hiResCrossfadeResample';
import { sanitizeStreamMaxBitRateKbps, sanitizeStreamRequestFormat } from '@/lib/audio/streamQuality';
import { sanitizePauseResumeFadeSecs } from '@/lib/audio/pauseResumeFade';
import {
  sanitizeAutodjOverlapCapMode,
  sanitizeAutodjOverlapCapSec,
} from '@/lib/audio/autodjOverlapCap';
import {
  LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS,
  clampStoredLoudnessPreAnalysisAttenuationRefDb,
} from '@/lib/audio/loudnessPreAnalysisSlider';
import {
  DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
  clampScrobbleThresholdPercent,
} from './authStoreDefaults';
import {
  clampMixFilterMinStars,
  clampRandomMixSize,
  clampLibraryGridMaxColumns,
  sanitizeLoudnessLufsPreset,
  sanitizeLoudnessPreAnalysisFromStorage,
  sanitizeSkipStarCounts,
  sanitizeSmartPlaylistCustomFields,
} from './authStoreHelpers';
import type {
  AuthState,
  ArtistBrowseCreditMode,
  DiscordCoverSource,
  DurationMode,
  LyricsSourceConfig,
  QueueDisplayMode,
  SeekbarStyle,
  WindowButtonStyle,
} from './authStoreTypes';
import { migrateLegacyLastfm, sanitizeAccounts } from '../music-network';
import { deriveLibraryBrowseServerIdsWithFallback } from '@/lib/library/libraryBrowseScope';
import { sanitizeDebugLoggingDepth } from '@/lib/perf/debugLoggingMode';

/**
 * Computes the post-rehydration patch for the auth store. Runs all
 * legacy-shape migrations + numeric sanitization that the persist
 * middleware can't express declaratively. The caller (the store's
 * `onRehydrateStorage` callback) applies the returned partial via
 * `useAuthStore.setState`.
 *
 * Side effects this function takes: deletes obsolete legacy fields
 * directly off the rehydrated state object (`animationMode`,
 * `reducedAnimations`) so they don't sit as cruft in localStorage,
 * and writes the one-shot Linux smooth-scroll migration sentinel.
 */
export function computeAuthStoreRehydration(state: AuthState): Partial<AuthState> {
  // Drop removed preload-next-track settings from legacy persist blobs.
  delete (state as { preloadMode?: unknown }).preloadMode;
  delete (state as { preloadCustomSeconds?: unknown }).preloadCustomSeconds;

  // Migrate lyricsServerFirst + enableNeteaselyrics → lyricsSources (one-time).
  // Only for an *existing* persisted state (upgrade from a build without
  // lyricsSources). Fresh installs have no persisted state → keep the
  // all-off default (issue #810); don't resurrect the old on-by-default set.
  let lyricsSourcesMigrated: { lyricsSources?: LyricsSourceConfig[] } = {};
  try {
    const raw = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}') as { state?: Record<string, unknown> };
    if (raw?.state && !raw.state.lyricsSources) {
      const serverFirst = (raw?.state?.lyricsServerFirst as boolean | undefined) ?? true;
      const neteaseOn   = (raw?.state?.enableNeteaselyrics as boolean | undefined) ?? false;
      const migrated: LyricsSourceConfig[] = serverFirst
        ? [{ id: 'server', enabled: true }, { id: 'lrclib', enabled: true }, { id: 'netease', enabled: neteaseOn }]
        : [{ id: 'lrclib', enabled: true }, { id: 'server', enabled: true }, { id: 'netease', enabled: neteaseOn }];
      lyricsSourcesMigrated = { lyricsSources: migrated };
    }
  } catch { /* ignore */ }

  // The YouLyPlus option was removed (issue #1386): every host of its backend is
  // gone and the upstream project cannot fund a replacement. Anyone who relied on
  // it would silently end up without lyrics, so switch them to LRCLIB — but only
  // when no other source is enabled, so a deliberate selection stays untouched.
  // Both the field and the even older `lyricsMode` flag are stripped afterwards.
  const legacyLyricsMode = (state as { lyricsMode?: unknown }).lyricsMode;
  const hadYouLyPlus =
    (state as { youLyPlusEnabled?: unknown }).youLyPlusEnabled === true ||
    legacyLyricsMode === 'lyricsplus';
  delete (state as { lyricsMode?: unknown }).lyricsMode;
  delete (state as { youLyPlusEnabled?: unknown }).youLyPlusEnabled;

  let youLyPlusRetired: { lyricsSources?: LyricsSourceConfig[] } = {};
  if (hadYouLyPlus) {
    const current =
      lyricsSourcesMigrated.lyricsSources ??
      (state as { lyricsSources?: LyricsSourceConfig[] }).lyricsSources;
    if (Array.isArray(current) && !current.some(s => s.enabled)) {
      youLyPlusRetired = {
        lyricsSources: current.map(s => (s.id === 'lrclib' ? { ...s, enabled: true } : s)),
      };
    }
  }

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

  // Unknown / missing / tampered window-button style falls back to the
  // default 'dots' so the title bar never renders an unstyled data-attr.
  const VALID_WINDOW_BUTTON_STYLES = new Set<string>([
    'dots', 'dotsGlyph', 'flat', 'pill', 'outline', 'glyph',
  ]);
  const windowButtonStyleMigrated = VALID_WINDOW_BUTTON_STYLES.has(
    (state as { windowButtonStyle?: unknown }).windowButtonStyle as string,
  )
    ? {}
    : { windowButtonStyle: 'dots' as WindowButtonStyle };

  // Garbage / null / undefined / missing key from a legacy or tampered persist
  // payload maps back to 'total' so the duration chip never receives an
  // unknown mode (would render an empty label).
  const VALID_QUEUE_DURATION_MODES = new Set<string>(['total', 'remaining', 'eta']);
  const queueDurationDisplayModeMigrated = VALID_QUEUE_DURATION_MODES.has(
    (state as { queueDurationDisplayMode?: unknown }).queueDurationDisplayMode as string,
  )
    ? {}
    : { queueDurationDisplayMode: 'total' as DurationMode };

  // Missing key (pre-feature persist) / garbage maps to 'queue' — the default
  // mode, which lists only upcoming tracks.
  const VALID_QUEUE_DISPLAY_MODES = new Set<string>(['playlist', 'queue', 'timeline']);
  const queueDisplayModeMigrated = VALID_QUEUE_DISPLAY_MODES.has(
    (state as { queueDisplayMode?: unknown }).queueDisplayMode as string,
  )
    ? {}
    : { queueDisplayMode: 'queue' as QueueDisplayMode };

  const VALID_ARTIST_BROWSE_CREDIT_MODES = new Set<string>(['album', 'track']);
  const artistBrowseCreditModeMigrated = VALID_ARTIST_BROWSE_CREDIT_MODES.has(
    (state as { artistBrowseCreditMode?: unknown }).artistBrowseCreditMode as string,
  )
    ? {}
    : { artistBrowseCreditMode: 'album' as ArtistBrowseCreditMode };

  const VALID_WAYLAND_TEXT_PROFILE = new Set<string>(['balanced', 'sharp', 'gpu', 'minimal']);
  const rawWaylandProfile = (state as { linuxWaylandTextRenderProfile?: unknown }).linuxWaylandTextRenderProfile;
  const linuxWaylandTextRenderProfileMigrated = VALID_WAYLAND_TEXT_PROFILE.has(rawWaylandProfile as string)
    ? {}
    : { linuxWaylandTextRenderProfile: 'sharp' as const };

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
  // One-time: the 'server' cover source was removed in PR #1246 (it leaked
  // authenticated Subsonic credentials) and reinstated in PR #1299 via a
  // credential-free implementation. A value that predates the reinstatement
  // must not be silently honored — a user who skipped every build between
  // those two PRs would otherwise have their pre-#1246 'server' preference
  // resurrected on first launch, without ever seeing the new opt-in
  // disclosure copy. Runs exactly once (guarded by a sentinel, same pattern
  // as the maxCacheMb migration below) so re-selecting 'server' afterward is
  // never coerced back.
  const discordServerCoverRevivalMigrationKey = 'psysonic-discord-server-cover-revival-v1';
  try {
    if (!localStorage.getItem(discordServerCoverRevivalMigrationKey)) {
      if ((state as { discordCoverSource?: unknown }).discordCoverSource === 'server') {
        discordCoverSourceMigrated = { discordCoverSource: 'none' };
      }
      localStorage.setItem(discordServerCoverRevivalMigrationKey, '1');
    }
  } catch { /* ignore */ }
  // One-time: legacy unified `maxCacheMb` cap removed from Settings (offline + IDB covers).
  const maxCacheMbMigrationKey = 'psysonic-max-cache-mb-removed-v1';
  let maxCacheMbMigrated: { maxCacheMb?: number } = {};
  try {
    if (!localStorage.getItem(maxCacheMbMigrationKey)) {
      maxCacheMbMigrated = { maxCacheMb: 0 };
      localStorage.setItem(maxCacheMbMigrationKey, '1');
    }
  } catch { /* ignore */ }

  // Music Network: one-time migration of the legacy flat lastfm* fields into the
  // accounts[] model. Runs exactly once (guarded by a sentinel) so a later
  // disconnect can't resurrect the account from the still-present legacy fields.
  // Subsequent rehydrates only sanitize the persisted account list.
  const musicNetworkMigrationKey = 'psysonic-music-network-migrated-v1';
  let musicNetworkMigrated: Partial<AuthState> = {
    musicNetworkAccounts: sanitizeAccounts(
      (state as { musicNetworkAccounts?: unknown }).musicNetworkAccounts,
    ),
  };
  try {
    if (!localStorage.getItem(musicNetworkMigrationKey)) {
      // The legacy lastfm* fields no longer exist on AuthState; read them off the
      // persisted blob (present on upgrade) via a cast.
      const legacy = state as unknown as {
        lastfmSessionKey?: string;
        lastfmUsername?: string;
        scrobblingEnabled?: boolean;
      };
      const migrated = migrateLegacyLastfm(
        {
          lastfmSessionKey: legacy.lastfmSessionKey,
          lastfmUsername: legacy.lastfmUsername,
          scrobblingEnabled: legacy.scrobblingEnabled,
        },
        () => crypto.randomUUID(),
      );
      musicNetworkMigrated = {
        musicNetworkAccounts: migrated.accounts,
        enrichmentPrimaryId: migrated.enrichmentPrimaryId,
        scrobblingMasterEnabled: migrated.scrobblingMasterEnabled,
      };
      localStorage.setItem(musicNetworkMigrationKey, '1');
    }
  } catch { /* ignore */ }

  // Strip the legacy flat lastfm* fields from the persisted blob (spec §6.1.3).
  // The migration above maps them into accounts[]; the sentinel guards
  // re-migration, so these now sit as pure cruft. Drop them on every rehydrate.
  for (const k of ['lastfmApiKey', 'lastfmApiSecret', 'lastfmSessionKey', 'lastfmUsername', 'lastfmSessionError', 'scrobblingEnabled']) {
    delete (state as unknown as Record<string, unknown>)[k];
  }

  let mediaDirMigrated: { mediaDir?: string } = {};
  const stMedia = state as { mediaDir?: unknown; offlineDownloadDir?: string; hotCacheDownloadDir?: string };
  if (!stMedia.mediaDir || (typeof stMedia.mediaDir === 'string' && stMedia.mediaDir.trim() === '')) {
    const offline = (stMedia.offlineDownloadDir ?? '').trim();
    const hot = (stMedia.hotCacheDownloadDir ?? '').trim();
    if (offline && (!hot || offline === hot)) {
      mediaDirMigrated = { mediaDir: offline };
    } else if (hot) {
      mediaDirMigrated = { mediaDir: hot };
    }
  }

  const serverIds = new Set(state.servers.map(server => server.id));
  const rawBrowseServerIds = (state as { libraryBrowseServerIds?: unknown }).libraryBrowseServerIds;
  const selectedBrowseIds = new Set(
    Array.isArray(rawBrowseServerIds)
      ? rawBrowseServerIds.filter((id): id is string => typeof id === 'string' && serverIds.has(id))
      : [],
  );
  const libraryBrowseServerIds = deriveLibraryBrowseServerIdsWithFallback({
    servers: state.servers,
    activeServerId: state.activeServerId,
    libraryBrowseServerIds: [...selectedBrowseIds],
  });
  const rawFoldersByServer = (state as { musicFoldersByServer?: unknown }).musicFoldersByServer;
  const musicFoldersByServer = Object.fromEntries(
    Object.entries(rawFoldersByServer && typeof rawFoldersByServer === 'object' ? rawFoldersByServer : {})
      .filter(([serverId, folders]) => serverIds.has(serverId) && Array.isArray(folders))
      .map(([serverId, folders]) => [
        serverId,
        (folders as unknown[]).filter((folder): folder is { id: string; name: string } => {
          if (!folder || typeof folder !== 'object') return false;
          const value = folder as { id?: unknown; name?: unknown };
          return typeof value.id === 'string' && typeof value.name === 'string';
        }),
      ]),
  );
  const rawBrowseSelections = (state as { libraryBrowseSelectionByServer?: unknown }).libraryBrowseSelectionByServer;
  const libraryBrowseSelectionByServer = Object.fromEntries(
    Object.entries(rawBrowseSelections && typeof rawBrowseSelections === 'object' ? rawBrowseSelections : {})
      .filter(([serverId, selection]) => serverIds.has(serverId) && Array.isArray(selection))
      .map(([serverId, selection]) => [serverId, [...new Set((selection as unknown[]).filter((id): id is string => typeof id === 'string'))]]),
  );

  return {
    ...mediaDirMigrated,
    ...musicNetworkMigrated,
    libraryBrowseServerIds,
    musicFoldersByServer,
    libraryBrowseSelectionByServer,
    libraryBrowseScopeVersion: 0,
    debugLoggingDepth: sanitizeDebugLoggingDepth(
      (state as { debugLoggingDepth?: unknown }).debugLoggingDepth,
    ),
    musicFolders: state.activeServerId ? (musicFoldersByServer[state.activeServerId] ?? []) : [],
    ...(state.startMinimizedToTray && state.showTrayIcon === false
      ? { startMinimizedToTray: false as const }
      : {}),
    mixMinRatingSong: clampMixFilterMinStars(state.mixMinRatingSong as number),
    mixMinRatingAlbum: clampMixFilterMinStars(state.mixMinRatingAlbum as number),
    mixMinRatingArtist: clampMixFilterMinStars(state.mixMinRatingArtist as number),
    randomMixSize: clampRandomMixSize(state.randomMixSize as number),
    scrobbleThresholdPercent: clampScrobbleThresholdPercent(
      (state as { scrobbleThresholdPercent?: unknown }).scrobbleThresholdPercent,
    ),
    forceScrobbleEnabled: state.forceScrobbleEnabled === true,
    libraryGridMaxColumns: clampLibraryGridMaxColumns(
      (state as { libraryGridMaxColumns?: unknown }).libraryGridMaxColumns,
    ),
    // Immersive fullscreen-player portrait dim (0–80%). Guard against a legacy
    // or malformed persisted value so `--fs-portrait-dim` never becomes NaN.
    fsPortraitDim: (() => {
      const v = (state as { fsPortraitDim?: unknown }).fsPortraitDim;
      return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(80, Math.round(v))) : 28;
    })(),
    skipStarManualSkipCountsByKey: sanitizeSkipStarCounts(
      (state as { skipStarManualSkipCountsByKey?: unknown }).skipStarManualSkipCountsByKey,
    ),
    smartPlaylistCustomFields: sanitizeSmartPlaylistCustomFields(
      (state as { smartPlaylistCustomFields?: unknown }).smartPlaylistCustomFields,
    ),
    loudnessTargetLufs: targetSan,
    loudnessPreAnalysisAttenuationDb: preSan,
    loudnessPreIsRefV1: true,
    hiResCrossfadeResampleHz: sanitizeHiResCrossfadeResampleHz(
      (state as { hiResCrossfadeResampleHz?: unknown }).hiResCrossfadeResampleHz,
    ),
    streamQualityByAddress: (() => {
      const raw = (state as { streamQualityByAddress?: unknown }).streamQualityByAddress;
      if (!raw || typeof raw !== 'object') return {};
      const clean: Record<string, ReturnType<typeof sanitizeStreamMaxBitRateKbps>> = {};
      for (const [addr, v] of Object.entries(raw as Record<string, unknown>)) {
        const kbps = sanitizeStreamMaxBitRateKbps(v);
        if (kbps > 0 && addr) clean[addr] = kbps;
      }
      return clean;
    })(),
    streamFormatByAddress: (() => {
      const raw = (state as { streamFormatByAddress?: unknown }).streamFormatByAddress;
      if (!raw || typeof raw !== 'object') return {};
      const clean: Record<string, ReturnType<typeof sanitizeStreamRequestFormat>> = {};
      for (const [addr, v] of Object.entries(raw as Record<string, unknown>)) {
        const fmt = sanitizeStreamRequestFormat(v);
        if (fmt !== 'auto' && addr) clean[addr] = fmt;
      }
      return clean;
    })(),
    autodjOverlapCapMode: sanitizeAutodjOverlapCapMode(
      (state as { autodjOverlapCapMode?: unknown }).autodjOverlapCapMode,
    ),
    autodjOverlapCapSec: sanitizeAutodjOverlapCapSec(
      (state as { autodjOverlapCapSec?: unknown }).autodjOverlapCapSec,
    ),
    pauseResumeFadeSecs: sanitizePauseResumeFadeSecs(
      (state as { pauseResumeFadeSecs?: unknown }).pauseResumeFadeSecs,
    ),
    ...lyricsSourcesMigrated,
    ...youLyPlusRetired,
    ...wheelSmoothOneTime,
    ...seekbarStyleMigrated,
    ...windowButtonStyleMigrated,
    ...queueDurationDisplayModeMigrated,
    ...queueDisplayModeMigrated,
    ...artistBrowseCreditModeMigrated,
    ...linuxWaylandTextRenderProfileMigrated,
    ...discordCoverSourceMigrated,
    ...maxCacheMbMigrated,
  };
}
