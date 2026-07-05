export type PlaybackStrategy =
  | 'speed_corrected'
  | 'varispeed'
  | 'varispeed_semitones'
  | 'preserve_pitch';

/** Default strategy: speed only, pitch corrected automatically. */
export const DEFAULT_PLAYBACK_STRATEGY: PlaybackStrategy = 'speed_corrected';

export const PLAYBACK_STRATEGIES: PlaybackStrategy[] = [
  'speed_corrected',
  'varispeed',
  'varispeed_semitones',
  'preserve_pitch',
];

/**
 * Frontend-only strategies map onto a Rust engine strategy. `varispeed_semitones`
 * is a UI lens over varispeed: the user dials semitones, speed = 2^(st/12).
 */
export function engineStrategy(strategy: PlaybackStrategy): PlaybackStrategy {
  return strategy === 'varispeed_semitones' ? 'varispeed' : strategy;
}

export const PLAYBACK_SPEED_MIN = 0.5;
export const PLAYBACK_SPEED_MAX = 2.0;
export const PLAYBACK_SPEED_STEP = 0.05;
export const PLAYBACK_PITCH_MIN = -12;
export const PLAYBACK_PITCH_MAX = 12;
export const PLAYBACK_PITCH_STEP = 0.1;
export const PLAYBACK_SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

/** Fine-precision slider steps (opt-in via Advanced settings). */
export const PLAYBACK_SPEED_STEP_FINE = 0.01;
export const PLAYBACK_PITCH_STEP_FINE = 0.01;

export function playbackSpeedStep(fine: boolean): number {
  return fine ? PLAYBACK_SPEED_STEP_FINE : PLAYBACK_SPEED_STEP;
}

export function playbackPitchStep(fine: boolean): number {
  return fine ? PLAYBACK_PITCH_STEP_FINE : PLAYBACK_PITCH_STEP;
}

export function clampPlaybackSpeed(speed: number): number {
  return Math.max(PLAYBACK_SPEED_MIN, Math.min(PLAYBACK_SPEED_MAX, speed));
}

export function clampPlaybackPitch(semitones: number): number {
  return Math.max(PLAYBACK_PITCH_MIN, Math.min(PLAYBACK_PITCH_MAX, semitones));
}

/** Pitch sent to Rust: manual offset only in preserve_pitch strategy. */
export function effectivePlaybackPitch(
  strategy: PlaybackStrategy,
  pitchSemitones: number,
): number {
  return strategy === 'preserve_pitch' ? pitchSemitones : 0;
}

/** True when DSP should run (enabled + not neutral 1.0× / 0 st). */
export function isPlaybackEffectActive(
  enabled: boolean,
  strategy: PlaybackStrategy,
  speed: number,
  pitchSemitones: number,
): boolean {
  if (!enabled) return false;
  if (strategy === 'preserve_pitch') {
    return Math.abs(speed - 1) > 0.001 || Math.abs(pitchSemitones) > 0.001;
  }
  return Math.abs(speed - 1) > 0.001;
}

/** True when the engine applies playback-rate DSP (Orbit sessions force passthrough). */
export function isPlaybackRateApplied(
  enabled: boolean,
  strategy: PlaybackStrategy,
  speed: number,
  pitchSemitones: number,
  orbitSessionActive: boolean,
): boolean {
  if (orbitSessionActive) return false;
  return isPlaybackEffectActive(enabled, strategy, speed, pitchSemitones);
}

export function derivedVarispeedSemitones(speed: number): number {
  if (speed <= 0) return 0;
  return 12 * Math.log2(speed);
}

/** Inverse of {@link derivedVarispeedSemitones}: speed multiplier for a semitone offset. */
export function varispeedSpeedFromSemitones(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export function formatSpeedLabel(speed: number): string {
  return `${speed.toFixed(2)}×`;
}

export function formatPitchLabel(semitones: number, decimals = 1): string {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(semitones * factor) / factor;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(decimals)} st`;
}
