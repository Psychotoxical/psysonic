import { invoke } from '@tauri-apps/api/core';
import type { SearchResults } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';

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
  void invoke('frontend_debug_log', {
    scope: 'live-search',
    message: JSON.stringify({ step, details }),
  }).catch(() => {});
}
