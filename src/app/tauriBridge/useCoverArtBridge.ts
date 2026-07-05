import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  clearAllDiskSrcCache,
  forgetDiskSrcForServer,
  forgetDiskSrcPrefix,
} from '@/cover/diskSrcCache';
import { rememberDiskSrcLadder } from '@/cover/diskSrcLookup';
import { notifyCoverDiskReady } from '@/cover/diskHandoff';
import { invalidateCacheKey } from '@/cover';
import { COVER_ART_TIERS } from '@/cover/tiers';
import type { CoverArtTier, CoverCacheKind } from '@/cover/types';

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

type CoverBucketRenamedPayload = {
  oldKey: string;
  newKey: string;
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
      unsubs.push(
        await listen<CoverBucketRenamedPayload>('cover:bucket-renamed', ev => {
          // URL-change remigration moved the disk bucket from oldKey to newKey
          // (cover_cache_rename_server_bucket). Every in-memory disk-src cache
          // entry tagged under oldKey now points at a path that no longer
          // exists — drop them so the next read re-resolves under newKey via
          // the normal getDiskSrcForGrid path.
          if (!ev.payload?.oldKey) return;
          forgetDiskSrcForServer(ev.payload.oldKey);
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, []);
}
