import { invoke } from '@tauri-apps/api/core';
import type { Track } from '../store/playerStoreTypes';
import { useAuthStore } from '../store/authStore';
import { HOT_CACHE_PROTECT_AFTER_CURRENT, type HotCacheEntry } from '../store/hotCacheStore';

/** Settings → Logging → Debug (`frontend_debug_log` → Rust stderr), same as normalization / lucky-mix. */
export function hotCacheFrontendDebug(payload: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  void invoke('frontend_debug_log', {
    scope: 'hot-cache',
    message: JSON.stringify(payload),
  }).catch(() => {});
}

/** How many upcoming queue tracks may be prefetched (only current + next are eviction-protected). */
export const PREFETCH_AHEAD = 5;

export type PrefetchJob = { trackId: string; serverId: string; suffix: string };

export function entryKey(serverId: string, trackId: string): string {
  return `${serverId}:${trackId}`;
}

/** Sum of on-disk bytes for eviction-protected slots (current + next — same span as `evictToFit`). */
export function sumCachedBytesInProtectedWindow(
  queue: Track[],
  queueIndex: number,
  serverId: string,
  entries: Record<string, HotCacheEntry>,
): number {
  const protectLo = Math.max(0, queueIndex);
  const protectHi = Math.min(queue.length - 1, queueIndex + HOT_CACHE_PROTECT_AFTER_CURRENT);
  let sum = 0;
  for (let i = protectLo; i <= protectHi; i++) {
    const e = entries[entryKey(serverId, queue[i].id)];
    if (e) sum += e.sizeBytes || 0;
  }
  return sum;
}

/** Conservative size guess so we do not prefetch when the protected window could exceed the cap. */
export function estimateTrackHotCacheBytes(track: Track): number {
  const sz = track.size;
  if (typeof sz === 'number' && Number.isFinite(sz) && sz > 0) {
    return Math.ceil(sz * 1.06);
  }
  const dur =
    typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
      ? track.duration
      : 240;
  const sfx = (track.suffix || '').toLowerCase();
  const lossless = /^(flac|wav|dsf|dff|alac|ape|wv)$/.test(sfx);
  let kbps =
    typeof track.bitRate === 'number' && Number.isFinite(track.bitRate) && track.bitRate > 0
      ? track.bitRate
      : 320;
  if (lossless && kbps < 800) {
    kbps = Math.max(kbps, 900);
  }
  const raw = Math.ceil((dur * kbps * 1000) / 8);
  return Math.max(256 * 1024, Math.ceil(raw * (lossless ? 1.2 : 1.15)));
}

export function debounceMs(): number {
  const s = useAuthStore.getState().hotCacheDebounceSec;
  if (!Number.isFinite(s) || s < 0) return 0;
  return Math.min(600, s) * 1000;
}
