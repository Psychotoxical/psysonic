import { useEffect } from 'react';
import { commands } from '@/generated/bindings';

const EVICT_TICK_MS = 45_000;

/** LRU eviction when cover disk cache crosses high watermark (spec §2.3). */
export function useCoverCacheEvictTick(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      void commands.coverCacheEvictTick().catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, EVICT_TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
}
