import { IS_LINUX } from '../utils/platform';
import {
  LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS,
  clampStoredLoudnessPreAnalysisAttenuationRefDb,
} from '../utils/loudnessPreAnalysisSlider';
import { DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB } from './authStoreDefaults';
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

  return {
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
  };
}
