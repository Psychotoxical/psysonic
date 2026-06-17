/**
 * Derive leading / trailing "empty tail" offsets for a track straight from the
 * cached waveform bins we already have — no extra analysis pass, no new cache
 * fields. The bins are the peak (+ mean) curve produced by the analysis decode
 * and are **percentile-normalised** (silence floors near the bottom of the
 * 0…255 range, ~8 on the PCM path / 0 on the byte-envelope fallback), so we use
 * a low absolute cut that catches both. Bin → seconds uses the known track
 * duration (`sec_per_bin = duration / bins`).
 *
 * Granularity is one bin (~0.5 s for a 4-min track at 500 bins) — by design;
 * this is for trimming dead air between crossfaded tracks, not sample-accurate
 * editing. The per-side trim is capped so a long musical fade-out cannot be
 * mistaken for silence and eaten whole.
 */
export interface WaveformSilenceBounds {
  /** Seconds of leading silence to skip (0 when none / unknown). */
  leadSilenceSec: number;
  /** Seconds of trailing silence to skip (0 when none / unknown). */
  trailSilenceSec: number;
  /** Playback start offset past the leading silence. */
  contentStartSec: number;
  /** End of musical content (track end minus trailing silence). */
  contentEndSec: number;
}

export interface WaveformSilenceOptions {
  /** Bins at/below this 0…255 value count as silence. Default 12. */
  cut?: number;
  /** Hard cap on trim per side, in seconds. Default 5. */
  maxTrimSec?: number;
}

const DEFAULT_SILENCE_CUT = 12;
const DEFAULT_MAX_TRIM_SEC = 5;

/**
 * Compute silence bounds for `bins` over a track of `durationSec`.
 * Returns a no-trim result (`lead/trail = 0`, content = full track) whenever the
 * input is missing, the duration is invalid, or the track is effectively silent.
 */
export function computeWaveformSilence(
  bins: number[] | null | undefined,
  durationSec: number,
  opts: WaveformSilenceOptions = {},
): WaveformSilenceBounds {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const none: WaveformSilenceBounds = {
    leadSilenceSec: 0,
    trailSilenceSec: 0,
    contentStartSec: 0,
    contentEndSec: dur,
  };
  if (!bins || dur <= 0) return none;

  // Dual-curve payload is peak ++ mean; use the peak half. Legacy single curve
  // (length === peak length) is used as-is.
  const peak = bins.length >= 1000 ? bins.slice(0, Math.floor(bins.length / 2)) : bins;
  const n = peak.length;
  if (n === 0) return none;

  const cut = opts.cut ?? DEFAULT_SILENCE_CUT;
  const maxTrimSec = opts.maxTrimSec ?? DEFAULT_MAX_TRIM_SEC;

  // Guard against an all-quiet curve (silent / undecoded track): never trim a
  // whole track to nothing.
  let anyLoud = false;
  for (let i = 0; i < n; i++) {
    if (peak[i] > cut) { anyLoud = true; break; }
  }
  if (!anyLoud) return none;

  let leadBins = 0;
  while (leadBins < n && peak[leadBins] <= cut) leadBins++;
  let trailBins = 0;
  while (trailBins < n && peak[n - 1 - trailBins] <= cut) trailBins++;

  const secPerBin = dur / n;
  const leadSilenceSec = Math.min(leadBins * secPerBin, maxTrimSec);
  const trailSilenceSec = Math.min(trailBins * secPerBin, maxTrimSec);

  // Degenerate overlap (shouldn't happen given the all-quiet guard, but keep
  // the contract: always leave a positive content window).
  if (leadSilenceSec + trailSilenceSec >= dur) return none;

  return {
    leadSilenceSec,
    trailSilenceSec,
    contentStartSec: leadSilenceSec,
    contentEndSec: dur - trailSilenceSec,
  };
}
