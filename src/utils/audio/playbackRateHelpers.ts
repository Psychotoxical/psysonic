export type PlaybackStrategy = 'speed_corrected' | 'varispeed' | 'preserve_pitch';

/** Default strategy: speed only, pitch corrected automatically. */
export const DEFAULT_PLAYBACK_STRATEGY: PlaybackStrategy = 'speed_corrected';

export const PLAYBACK_STRATEGIES: PlaybackStrategy[] = [
  'speed_corrected',
  'varispeed',
  'preserve_pitch',
];

export const PLAYBACK_SPEED_MIN = 0.5;
export const PLAYBACK_SPEED_MAX = 2.0;
export const PLAYBACK_SPEED_STEP = 0.05;
export const PLAYBACK_PITCH_MIN = -12;
export const PLAYBACK_PITCH_MAX = 12;
export const PLAYBACK_PITCH_STEP = 0.1;
export const PLAYBACK_SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

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

export function formatSpeedLabel(speed: number): string {
  return `${speed.toFixed(1)}×`;
}

export function formatPitchLabel(semitones: number): string {
  const rounded = Math.round(semitones * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)} st` : `${rounded.toFixed(1)} st`;
}
