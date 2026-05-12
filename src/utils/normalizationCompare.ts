/**
 * Tolerant equality for normalization gain values. Both arguments may be null
 * (meaning "no override / unknown"); two nulls compare equal, mixed null/number
 * does not. Default epsilon (0.12 dB) is the threshold below which the audible
 * difference is negligible — used to skip UI updates that would otherwise jitter
 * on every analysis-cache refresh.
 */
export function normalizationAlmostEqual(a: number | null, b: number | null, eps = 0.12): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}
