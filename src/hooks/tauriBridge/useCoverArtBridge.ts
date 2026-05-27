import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  clearAllDiskSrcCache,
  forgetDiskSrcPrefix,
} from '../../cover/diskSrcCache';
import { rememberDiskSrcLadder } from '../../cover/diskSrcLookup';
import { notifyCoverDiskReady } from '../../cover/diskHandoff';
import { invalidateCacheKey } from '../../utils/imageCache';
import { COVER_ART_TIERS } from '../../cover/tiers';
import type { CoverArtTier, CoverCacheKind } from '../../cover/types';

type CoverTierReadyPayload = {
  serverIndexKey: string;
  cacheKind: CoverCacheKind;
  cacheEntityId: string;
  tier: CoverArtTier;
  path: string;
};

type CoverEvictedPayload = {
  serverIndexKey: string;
  cacheKind: CoverCacheKind;
  cacheEntityId: string;
};

/** Rust → UI: disk `.webp` ready — do not invalidate IDB (that caused webview refetch storms). */
export function useCoverArtBridge(): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<CoverTierReadyPayload>('cover:tier-ready', ev => {
          const { serverIndexKey, cacheKind, cacheEntityId, tier, path } = ev.payload;
          if (!path) return;
          const key = `${serverIndexKey}:cover:${cacheKind}:${cacheEntityId}:${tier}`;
          rememberDiskSrcLadder(serverIndexKey, { cacheKind, cacheEntityId }, tier, path);
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
          const { serverIndexKey, cacheKind, cacheEntityId } = ev.payload;
          forgetDiskSrcPrefix({
            serverScope: { kind: 'active' },
            cacheKind,
            cacheEntityId,
          });
          for (const tier of COVER_ART_TIERS) {
            notifyCoverDiskReady(`${serverIndexKey}:cover:${cacheKind}:${cacheEntityId}:${tier}`, '');
          }
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, []);
}
