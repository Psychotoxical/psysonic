import { frontendDebugLog } from '@/lib/api/debugLog';
import { useAuthStore } from '@/store/authStore';

/**
 * Forward a structured normalization-pipeline trace to the Rust-side debug
 * log file when Settings → Logging is set to **Debug**. A no-op otherwise,
 * so the dozens of call sites in `playerStore` (refresh / backfill / engine
 * sync / track-switch instrumentation) carry zero cost in normal mode.
 *
 * Errors invoking the Rust command are swallowed — this is best-effort
 * instrumentation, not a playback dependency.
 */
export function emitNormalizationDebug(step: string, details?: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  frontendDebugLog('normalization', JSON.stringify({ step, details }));
}
