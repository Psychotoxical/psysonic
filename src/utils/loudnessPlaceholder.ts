/**
 * Before SQLite has integrated LUFS, match Rust `loudness_gain_placeholder_until_cache`:
 * pivot at -14 LUFS, `true_peak = 0` (no EBU headroom cap), then add pre-attenuation from settings.
 */
const PLACEHOLDER_INTEGRATED_LUFS = -14;

export function loudnessGainPlaceholderUntilCacheDb(
  targetLufs: number,
  preAnalysisAttenuationDb: number,
): number {
  const pre = Math.min(0, Math.max(-24, preAnalysisAttenuationDb));
  let pivot = targetLufs - PLACEHOLDER_INTEGRATED_LUFS;
  pivot = Math.max(-24, Math.min(24, pivot));
  return Math.max(-24, Math.min(24, pivot + pre));
}
