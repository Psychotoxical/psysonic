import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

const EVICT_TICK_MS = 45_000;

/** LRU eviction when cover disk cache crosses high watermark (spec §2.3). */
export function useCoverCacheEvictTick(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      void invoke<number>('cover_cache_evict_tick', {}).catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, EVICT_TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
}
