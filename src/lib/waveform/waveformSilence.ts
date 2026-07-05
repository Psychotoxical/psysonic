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
 * Dual-curve payload is peak ++ mean; use the peak half. Legacy single curve
 * (length === peak length) is used as-is.
 */
function peakHalf(bins: number[]): number[] {
  return bins.length >= 1000 ? bins.slice(0, Math.floor(bins.length / 2)) : bins;
}

/** High-percentile ("plateau") level of `peak[startBin..endBin)` above the cut. */
function plateauLevel(peak: number[], startBin: number, endBin: number, cut: number): number {
  const loud: number[] = [];
  for (let i = Math.max(0, startBin); i < Math.min(peak.length, endBin); i++) {
    if (peak[i] > cut) loud.push(peak[i]);
  }
  if (loud.length === 0) return 0;
  loud.sort((a, b) => a - b);
  return loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.75))];
}

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

  const peak = peakHalf(bins);
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

/** Boundary shape: silence bounds + the length of the gentle fade/rise regions. */
export interface BoundaryShape extends WaveformSilenceBounds {
  /** Seconds of trailing decay (plateau → floor) just before `contentEndSec`. */
  outroFadeSec: number;
  /** Seconds of leading rise (floor → plateau) just after `contentStartSec`. */
  introRiseSec: number;
}

/**
 * Extend {@link computeWaveformSilence} with the *shape* of the track's edges:
 * how long the music takes to rise to full level at the start (`introRiseSec`)
 * and how long it decays at the end (`outroFadeSec`). A long musical fade-out or
 * a quiet count-in produces a large value; a hard cut/abrupt start → ~0. These
 * drive the dynamic crossfade overlap (phase 2).
 */
export function analyzeBoundary(
  bins: number[] | null | undefined,
  durationSec: number,
  opts: WaveformSilenceOptions = {},
): BoundaryShape {
  const base = computeWaveformSilence(bins, durationSec, opts);
  const dur = base.contentEndSec + base.trailSilenceSec; // == sanitised duration
  if (!bins || !(dur > 0)) return { ...base, outroFadeSec: 0, introRiseSec: 0 };

  const peak = peakHalf(bins);
  const n = peak.length;
  if (n === 0) return { ...base, outroFadeSec: 0, introRiseSec: 0 };

  const cut = opts.cut ?? DEFAULT_SILENCE_CUT;
  const secPerBin = dur / n;
  const startBin = Math.min(n - 1, Math.max(0, Math.round(base.contentStartSec / secPerBin)));
  const endBin = Math.min(n, Math.max(startBin + 1, Math.round(base.contentEndSec / secPerBin)));

  const plateau = plateauLevel(peak, startBin, endBin, cut);
  // "Full level" target for the rise/decay edges: halfway between cut and plateau.
  const riseTarget = Math.max(cut + 1, plateau * 0.5);

  let i = startBin;
  while (i < endBin && peak[i] < riseTarget) i++;
  const introRiseSec = (i - startBin) * secPerBin;

  let j = endBin - 1;
  while (j >= startBin && peak[j] < riseTarget) j--;
  const outroFadeSec = Math.max(0, (endBin - 1 - j) * secPerBin);

  return { ...base, outroFadeSec, introRiseSec };
}

/** Engine fade min/max — the override is clamped to the same range on the Rust side. */
const DYNAMIC_OVERLAP_MIN_SEC = 0.5;
export const DYNAMIC_OVERLAP_HARD_CAP_SEC = 12;
export const DYNAMIC_OVERLAP_ABSOLUTE_MAX_SEC = 30;

/**
 * Standard pleasant blend used when *both* edges are known but neither fades —
 * a hard, loud→loud meeting (e.g. a track that ends loud but had protective
 * trailing silence we trim away, butting up against a loud intro). A bare
 * anti-click floor (~0.5 s) would sound like an abrupt cut, so we equal-power
 * crossfade over this many seconds instead.
 */
export const STANDARD_BLEND_SEC = 2.0;

/**
 * A's own outro fade must be at least this long (≥2 waveform bins of decay at
 * 500 bins / 4-min track) before we trust it enough to suppress the engine
 * fade-out and let the *recording* carry A down to silence (scenario A).
 */
const OWN_FADE_TRUST_SEC = 1.0;

/** A per-transition crossfade plan derived from both tracks' envelopes. */
export interface CrossfadeTransitionPlan {
  /** Where the incoming track should begin playing (leading silence skipped). */
  bStartSec: number;
  /** Fade length both sides use, derived purely from the audio's fade/rise shape. */
  overlapSec: number;
  /**
   * Engine fade-out length for the *outgoing* track A, decoupled from B's
   * fade-in (`overlapSec`):
   *   • `0`  → A already fades out in the recording, so don't double-fade it —
   *            it rides at full engine gain while B rises underneath (scenario A);
   *   • else → fade A over this many seconds (== `overlapSec`; A has no natural
   *            fade, e.g. a hard cut, so the engine supplies one).
   */
  outgoingFadeSec: number;
}

export interface CrossfadePlanOptions extends WaveformSilenceOptions {
  /** Floor on the overlap (anti-click). Default 0.5 s (matches the engine clamp). */
  minOverlapSec?: number;
  /** Hard cap on the overlap. Default 12 s (engine max). */
  maxOverlapSec?: number;
}

/**
 * Pick a crossfade overlap + incoming start offset purely from what the two
 * tracks *actually sound like* at the boundary — the user's `crossfadeSecs` is
 * **not** involved in this mode ("work by fact"):
 *
 *   `overlap = clamp( max(outroFadeA, introRiseB), min, cap )`
 *
 * The overlap spans exactly the outgoing track's natural fade-out and/or the
 * incoming track's quiet buildup, positioned to **end** at A's content end
 * (`audioEventHandlers` advances at `contentEndA − overlap`) with B starting past
 * its own leading silence. So:
 *   • a real fade-out / buildup → a long blend that overlaps the *audible* tail
 *     and head (B rises under A instead of blaring in after A went quiet);
 *   • two hard edges (no fade, no buildup) → collapses to the `min` floor — a
 *     quick blend, because there is simply nothing gradual to mix.
 *
 * Equal-power fades keep the summed loudness flat. Returns `overlapSec = min`
 * (and `bStartSec = 0`) when an envelope is missing — the caller then leaves the
 * normal engine-driven crossfade in charge.
 */
export function planCrossfadeTransition(
  aBins: number[] | null | undefined,
  aDurationSec: number,
  bBins: number[] | null | undefined,
  bDurationSec: number,
  opts: CrossfadePlanOptions = {},
): CrossfadeTransitionPlan {
  const min = Math.max(0.1, opts.minOverlapSec ?? DYNAMIC_OVERLAP_MIN_SEC);
  const capUpper = opts.maxOverlapSec ?? DYNAMIC_OVERLAP_HARD_CAP_SEC;
  const cap = Math.max(min, Math.min(capUpper, DYNAMIC_OVERLAP_ABSOLUTE_MAX_SEC));

  const aShape = analyzeBoundary(aBins, aDurationSec, opts);
  const bShape = analyzeBoundary(bBins, bDurationSec, opts);
  const bStartSec = bShape.contentStartSec;

  // Don't overlap more than ~90 % of the shorter content window (very short tracks).
  const aContentLen = Math.max(0, aShape.contentEndSec - aShape.contentStartSec);
  const bContentLen = Math.max(0, bShape.contentEndSec - bShape.contentStartSec);
  const sustainable = Math.min(aContentLen || cap, bContentLen || cap) * 0.9;

  const wanted = Math.max(aShape.outroFadeSec, bShape.introRiseSec);
  // When we've analysed both edges and nothing fades (a hard, loud→loud meeting
  // — typically a loud ending whose protective trailing silence we trim, into a
  // loud intro), don't butt them together with a near-cut: blend over a standard
  // ~2 s instead. A real fade-out/buildup keeps its (longer) content-driven span.
  const haveBothEdges = !!aBins && !!bBins;
  const target = haveBothEdges ? Math.max(wanted, STANDARD_BLEND_SEC) : (wanted || min);
  const overlapSec = Math.max(min, Math.min(cap, sustainable, target));

  // Scenario A: when A's own outro fade is the reason for the overlap (a real,
  // trustworthy fade that's at least as long as B's intro rise), let the
  // recording fade A out and skip the engine's fade-out — otherwise A would be
  // attenuated twice (recording × engine) and vanish too soon under B.
  const aRidesOwnFade =
    aShape.outroFadeSec >= OWN_FADE_TRUST_SEC && aShape.outroFadeSec >= bShape.introRiseSec;
  const outgoingFadeSec = aRidesOwnFade ? 0 : overlapSec;

  return { overlapSec, bStartSec, outgoingFadeSec };
}
