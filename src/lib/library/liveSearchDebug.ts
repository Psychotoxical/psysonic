import { frontendDebugLog } from '@/lib/api/debugLog';
import type { SearchResults } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';

export function searchHitCounts(result: SearchResults): string {
  return `${result.artists.length}/${result.albums.length}/${result.songs.length}`;
}

export function searchResultSamples(result: SearchResults, max = 2) {
  return {
    artists: result.artists.slice(0, max).map(a => a.name),
    albums: result.albums.slice(0, max).map(a => a.name),
    songs: result.songs.slice(0, max).map(s => s.title),
  };
}

/**
 * Settings → Logging → **Debug** → Rust debug log file (`frontend_debug_log`).
 * Same transport as normalization / lucky-mix / orbit.
 */
export function emitLiveSearchDebug(step: string, details?: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  frontendDebugLog('live-search', JSON.stringify({ step, details }));
}
