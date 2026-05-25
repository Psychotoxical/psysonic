import { useEffect, useRef } from 'react';
import { coverCacheStats, libraryCoverBackfillBatch } from '../api/coverCache';
import { coverEnsureQueued } from '../cover/ensureQueue';
import { coverArtRef } from '../cover/ref';
import { coverStorageKey } from '../cover/storageKeys';
import { useAuthStore } from '../store/authStore';
import { libraryIsReady } from '../utils/library/libraryReady';
import { serverIndexKeyForProfile } from '../utils/server/serverIndexKey';

const STEADY_POLL_MS = 3000;
const BATCH_LIMIT = 12;
const CANONICAL_TIER = 800 as const;

/**
 * Background library cover warm-up — Rust disk cache only (no webview JPEG IDB).
 */
export function useLibraryCoverBackfill(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const server = useAuthStore(s =>
    s.activeServerId ? s.servers.find(srv => srv.id === s.activeServerId) : undefined,
  );
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !activeServerId || !server) return;
    let cancelled = false;
    const libraryServerId = activeServerId;
    const indexKey = serverIndexKeyForProfile(server);

    void (async () => {
      while (!cancelled) {
        if (!libraryIsReady(libraryServerId)) {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS));
          continue;
        }
        const stats = await coverCacheStats().catch(() => null);
        if (!stats?.autoDownloadEnabled) {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS * 2));
          continue;
        }

        const batch = await libraryCoverBackfillBatch(
          indexKey,
          libraryServerId,
          cursorRef.current,
          BATCH_LIMIT,
        ).catch(() => null);

        if (!batch || batch.coverIds.length === 0) {
          if (batch?.exhausted) cursorRef.current = null;
          await new Promise(r => setTimeout(r, STEADY_POLL_MS * 2));
          continue;
        }

        const scope = { kind: 'active' as const };
        await Promise.all(
          batch.coverIds.map(coverArtId => {
            const ref = coverArtRef(coverArtId, scope);
            const key = coverStorageKey(
              { kind: 'active' },
              coverArtId,
              CANONICAL_TIER,
            );
            return coverEnsureQueued(key, ref, CANONICAL_TIER, 'low');
          }),
        );

        cursorRef.current = batch.nextCursor;
        if (batch.exhausted) {
          cursorRef.current = null;
          await new Promise(r => setTimeout(r, 60_000));
        } else {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, activeServerId, server?.url]);
}
