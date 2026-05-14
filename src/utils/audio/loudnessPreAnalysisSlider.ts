/** Pre-analysis level is defined relative to a −14 LUFS target; engine uses an offset for other targets. */
export const LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS = -14 as const;

/**
 * dB actually applied by the engine (and placeholder math) for the current target.
 * Example: ref −4.5 dB at −14, at −12 → −2.5 dB.
 */
export function effectiveLoudnessPreAnalysisAttenuationDb(
  storedDbRelativeToRef: number,
  targetLufs: number,
): number {
  const stepped = Math.round(storedDbRelativeToRef * 2) / 2;
  const effective = stepped + (targetLufs - LOUDNESS_PRE_ANALYSIS_REF_TARGET_LUFS);
  return Math.max(-24, Math.min(0, effective));
}

/** Stored [−24, 0] dB, meaning “at −14 LUFS target”. */
export function clampStoredLoudnessPreAnalysisAttenuationRefDb(v: number): number {
  const n = Math.round(v * 2) / 2;
  return Math.max(-24, Math.min(0, n));
}
