import { useAuthStore } from './authStore';

/**
 * In-memory cache of the per-track loudness normalization gain (dB). Two
 * parallel maps:
 *
 *  - `cachedLoudnessGainByTrackId` — the dB value last computed (from an
 *    `analysis_get_loudness_for_track` row, a partial-loudness event, or
 *    a placeholder-until-cache value).
 *  - `stableLoudnessGainByTrackId` — `true` once the value has been
 *    promoted to the final cached/analysis-confirmed form. Engine bind
 *    only trusts entries flagged stable; partial / placeholder values
 *    deliberately omit the flag so Rust uses its pre-trim default until
 *    the analysis catches up.
 *
 * Keys can land in either the bare Subsonic id form or the `stream:`
 * prefixed form depending on which event surface wrote the entry —
 * `loudnessCacheStateKeysForTrackId` returns the two forms a caller may
 * need to look up or clear together.
 */

const cachedLoudnessGainByTrackId: Record<string, number> = {};
const stableLoudnessGainByTrackId: Record<string, true> = {};

/** Returns the two-form key list (bare id + `stream:<id>`) for paired lookups. */
export function loudnessCacheStateKeysForTrackId(trackId: string): string[] {
  if (!trackId) return [];
  const out: string[] = [trackId];
  if (trackId.startsWith('stream:')) {
    const bare = trackId.slice('stream:'.length);
    if (bare) out.push(bare);
  } else {
    out.push(`stream:${trackId}`);
  }
  return out;
}

export function getCachedLoudnessGain(trackId: string): number | undefined {
  return cachedLoudnessGainByTrackId[trackId];
}

export function setCachedLoudnessGain(trackId: string, gainDb: number): void {
  cachedLoudnessGainByTrackId[trackId] = gainDb;
}

export function hasStableLoudness(trackId: string): boolean {
  return Boolean(stableLoudnessGainByTrackId[trackId]);
}

/** Atomic: write the cached value AND mark it stable (analysis-confirmed). */
export function markLoudnessStable(trackId: string, gainDb: number): void {
  cachedLoudnessGainByTrackId[trackId] = gainDb;
  stableLoudnessGainByTrackId[trackId] = true;
}

/** Drop both maps for the literal track id (no stream-form expansion). */
export function forgetLoudnessGain(trackId: string): void {
  delete cachedLoudnessGainByTrackId[trackId];
  delete stableLoudnessGainByTrackId[trackId];
}

/** Drop both maps for each form of the track id (bare + `stream:<id>`). */
export function clearLoudnessCacheStateForTrackId(trackId: string): void {
  for (const k of loudnessCacheStateKeysForTrackId(trackId)) {
    delete cachedLoudnessGainByTrackId[k];
    delete stableLoudnessGainByTrackId[k];
  }
}

/**
 * Pass to `audio_play` / `audio_chain_preload` only — DB-backed gain. Omit
 * partial hints so Rust uses pre-trim until `analysis:loudness-partial` +
 * `audio_update_replay_gain`.
 */
export function loudnessGainDbForEngineBind(trackId: string | undefined | null): number | null {
  if (!trackId) return null;
  if (!stableLoudnessGainByTrackId[trackId]) return null;
  const v = cachedLoudnessGainByTrackId[trackId];
  return Number.isFinite(v) ? v : null;
}

/** True when ReplayGain is selected AND user has it enabled in Settings. */
export function isReplayGainActive(): boolean {
  const a = useAuthStore.getState();
  return a.normalizationEngine === 'replaygain' && a.replayGainEnabled;
}

/** Test-only: wipe both maps so each spec starts clean. */
export function _resetLoudnessGainCacheForTest(): void {
  for (const k of Object.keys(cachedLoudnessGainByTrackId)) delete cachedLoudnessGainByTrackId[k];
  for (const k of Object.keys(stableLoudnessGainByTrackId)) delete stableLoudnessGainByTrackId[k];
}
