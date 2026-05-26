import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  clearAllDiskSrcCache,
  forgetDiskSrcPrefix,
  rememberDiskSrc,
} from '../../cover/diskSrcCache';
import { notifyCoverDiskReady } from '../../cover/diskHandoff';
import { invalidateCacheKey } from '../../utils/imageCache';
import { COVER_ART_TIERS } from '../../cover/tiers';
import type { CoverArtTier } from '../../cover/types';

type CoverTierReadyPayload = {
  serverIndexKey: string;
  coverArtId: string;
  tier: CoverArtTier;
  path: string;
};

type CoverEvictedPayload = {
  serverIndexKey: string;
  coverArtId: string;
};

/** Rust → UI: disk `.webp` ready — do not invalidate IDB (that caused webview refetch storms). */
export function useCoverArtBridge(): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<CoverTierReadyPayload>('cover:tier-ready', ev => {
          const { serverIndexKey, coverArtId, tier, path } = ev.payload;
          if (!path) return;
          const key = `${serverIndexKey}:cover:${coverArtId}:${tier}`;
          rememberDiskSrc(key, path);
          notifyCoverDiskReady(key, path);
          void invalidateCacheKey(key);
        }),
      );
      unsubs.push(
        await listen('cover:cache-cleared', () => {
          clearAllDiskSrcCache();
        }),
      );
      unsubs.push(
        await listen<CoverEvictedPayload>('cover:evicted', ev => {
          const { serverIndexKey, coverArtId } = ev.payload;
          forgetDiskSrcPrefix(serverIndexKey, coverArtId);
          for (const tier of COVER_ART_TIERS) {
            notifyCoverDiskReady(`${serverIndexKey}:cover:${coverArtId}:${tier}`, '');
          }
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, []);
}
