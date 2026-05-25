import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invalidateCacheKey } from '../../utils/imageCache';
import { COVER_ART_TIERS } from '../../cover/tiers';
import type { CoverArtTier } from '../../cover/types';

type CoverTierReadyPayload = {
  serverId: string;
  coverArtId: string;
  tier: CoverArtTier;
  path: string;
};

type CoverEvictedPayload = {
  serverId: string;
  coverArtId: string;
};

/** Rust → UI handoff for disk tier files */
export function useCoverArtBridge(): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<CoverTierReadyPayload>('cover:tier-ready', ev => {
          const { serverId, coverArtId, tier } = ev.payload;
          const key = `${serverId}:cover:${coverArtId}:${tier}`;
          void invalidateCacheKey(key);
        }),
      );
      unsubs.push(
        await listen<CoverEvictedPayload>('cover:evicted', ev => {
          const { serverId, coverArtId } = ev.payload;
          for (const tier of COVER_ART_TIERS) {
            void invalidateCacheKey(`${serverId}:cover:${coverArtId}:${tier}`);
          }
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, []);
}
