import type { Track } from './playerStoreTypes';
import { invoke } from '@tauri-apps/api/core';
import { buildStreamUrl } from '../api/subsonic';
import { useHotCacheStore } from './hotCacheStore';
/**
 * Promote a track whose stream cache is full to the on-disk hot cache.
 * Rust copies the cached bytes into the hot-cache directory and returns
 * the resolved path + size; the JS-side `useHotCacheStore` index gets the
 * entry tagged `'stream-promote'` so the LRU treats it the same as a
 * prefetch hit.
 *
 * Best-effort: any failure is swallowed because the regular hot-cache
 * prefetch path remains a fallback. `customDir` may be null when the user
 * hasn't picked a hot-cache directory yet — Rust then writes to the
 * default location.
 */
export async function promoteCompletedStreamToHotCache(
  track: Track,
  serverId: string,
  customDir: string | null,
): Promise<void> {
  try {
    const res = await invoke<{ path: string; size: number } | null>(
      'promote_stream_cache_to_hot_cache',
      {
        trackId: track.id,
        serverId,
        url: buildStreamUrl(track.id),
        suffix: track.suffix || 'mp3',
        customDir,
      },
    );
    if (!res || !res.path) return;
    useHotCacheStore.getState().setEntry(track.id, serverId, res.path, res.size || 0, 'stream-promote');
  } catch {
    // best-effort promotion; normal hot-cache prefetch remains fallback
  }
}
