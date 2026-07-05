import { frontendDebugLog } from '@/lib/api/debugLog';
import { useAuthStore } from '@/store/authStore';

let sessionT0 = 0;
let navT0 = 0;

/**
 * Settings → System → Logging → **Debug** → terminal + `psysonic-logs-*.log`
 * (`frontend_debug_log` / `app_deprintln!`). Same transport as live-search / orbit.
 */
export function markAlbumBrowseNavIntent(source: string): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  navT0 = performance.now();
  emitAlbumBrowseNav('nav_intent', { source });
}

/** Navigation pipeline (click → route → lazy chunk → page mount). */
export function emitAlbumBrowseNav(
  step: string,
  details?: Record<string, unknown>,
): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  frontendDebugLog(
    'albums-browse',
    JSON.stringify({
      step,
      elapsedMs: navT0 ? Math.round(performance.now() - navT0) : 0,
      ...(details ? { details } : {}),
    }),
  );
}

export function beginAlbumBrowseTrace(details?: Record<string, unknown>): void {
  sessionT0 = performance.now();
  const navGapMs = navT0 ? Math.round(sessionT0 - navT0) : undefined;
  emitAlbumBrowseDebug('session_start', {
    ...details,
    ...(navGapMs != null ? { navGapMs } : {}),
  });
  if (navGapMs != null) {
    emitAlbumBrowseNav('page_mount', { navGapMs, sessionElapsedMs: 0 });
  }
}

export function emitAlbumBrowseDebug(
  step: string,
  details?: Record<string, unknown>,
): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  frontendDebugLog(
    'albums-browse',
    JSON.stringify({
      step,
      elapsedMs: sessionT0 ? Math.round(performance.now() - sessionT0) : 0,
      ...(details ? { details } : {}),
    }),
  );
}

export async function albumBrowseTimed<T>(
  step: string,
  fn: () => Promise<T>,
  details?: Record<string, unknown>,
): Promise<T> {
  if (useAuthStore.getState().loggingMode !== 'debug') return fn();
  const t0 = performance.now();
  emitAlbumBrowseDebug(`${step}_start`, details);
  try {
    const result = await fn();
    emitAlbumBrowseDebug(`${step}_done`, {
      ...details,
      stepMs: Math.round(performance.now() - t0),
    });
    return result;
  } catch (error) {
    emitAlbumBrowseDebug(`${step}_error`, {
      ...details,
      stepMs: Math.round(performance.now() - t0),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
