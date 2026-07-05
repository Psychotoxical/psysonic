import type { AuthState } from '@/store/authStoreTypes';
import { DYNAMIC_OVERLAP_HARD_CAP_SEC } from '@/lib/waveform/waveformSilence';

export type AutodjOverlapCapMode = 'auto' | 'limit';

export const AUTODJ_OVERLAP_CAP_MIN_SEC = 2;
export const AUTODJ_OVERLAP_CAP_MAX_SEC = 30;
export const DEFAULT_AUTODJ_OVERLAP_CAP_SEC = 15;

export function sanitizeAutodjOverlapCapSec(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTODJ_OVERLAP_CAP_SEC;
  return Math.min(AUTODJ_OVERLAP_CAP_MAX_SEC, Math.max(AUTODJ_OVERLAP_CAP_MIN_SEC, n));
}

export function sanitizeAutodjOverlapCapMode(value: unknown): AutodjOverlapCapMode {
  return value === 'limit' ? 'limit' : 'auto';
}

/** Upper bound (seconds) for content-driven AutoDJ overlap calculations. */
export function autodjMaxOverlapCapSec(
  auth: Pick<AuthState, 'autodjOverlapCapMode' | 'autodjOverlapCapSec'>,
): number {
  if (auth.autodjOverlapCapMode === 'auto') {
    return DYNAMIC_OVERLAP_HARD_CAP_SEC;
  }
  return sanitizeAutodjOverlapCapSec(auth.autodjOverlapCapSec);
}
