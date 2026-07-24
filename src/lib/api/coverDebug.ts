/**
 * Cover-pipeline diagnostics at Settings → Logging → Debug depth 3.
 * Mirrors {@link emitMultiServerDebug}: silent unless debug mode is on and depth ≥ 3.
 */
import { frontendDebugLog } from '@/lib/api/debugLog';
import {
  isDebugLoggingDepthEnabled,
  isDebugLoggingModeActive,
} from '@/lib/perf/debugLoggingMode';

/** High-detail cover diagnostics (mf-/warm/ensure), available at debug depth 3. */
export function emitCoverDebug(
  step: string,
  details: Record<string, unknown> = {},
): void {
  if (!isDebugLoggingModeActive() || !isDebugLoggingDepthEnabled(3)) return;
  frontendDebugLog('cover', JSON.stringify({ step, details }), 3);
}
