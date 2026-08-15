export const PAUSE_RESUME_FADE_MIN_SECS = 0.1;
export const PAUSE_RESUME_FADE_MAX_SECS = 2;
export const PAUSE_RESUME_FADE_DEFAULT_SECS = 1;

export function sanitizePauseResumeFadeSecs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return PAUSE_RESUME_FADE_DEFAULT_SECS;
  return Math.max(PAUSE_RESUME_FADE_MIN_SECS, Math.min(PAUSE_RESUME_FADE_MAX_SECS, n));
}
