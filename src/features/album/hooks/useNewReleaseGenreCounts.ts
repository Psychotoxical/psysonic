import { useEffect, useRef, useState } from 'react';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import { loadLocalNewReleases } from '@/lib/library/newReleasesLocal';

export const NEW_RELEASE_GENRE_COUNTS_DELAY_MS = 1_000;

interface Args {
  anchorServerId: string | null;
  scopes: LibraryScopePair[];
  scopeFingerprint: string;
  musicLibraryFilterVersion: number;
  feedReady: boolean;
  enabled: boolean;
}

export function useNewReleaseGenreCounts({
  anchorServerId,
  scopes,
  scopeFingerprint,
  musicLibraryFilterVersion,
  feedReady,
  enabled,
}: Args): Array<{ genre: string; count: number }> {
  const resultKey = `${scopeFingerprint}\u0001${musicLibraryFilterVersion}`;
  const [result, setResult] = useState<{
    key: string;
    counts: Array<{ genre: string; count: number }>;
  }>({ key: '', counts: [] });
  const scopesRef = useRef(scopes);
  useEffect(() => {
    scopesRef.current = scopes;
  }, [scopes]);

  useEffect(() => {
    if (!enabled || !feedReady || !anchorServerId || scopesRef.current.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadLocalNewReleases(
        anchorServerId,
        scopesRef.current,
        1,
        0,
        [],
        true,
      ).then(result => {
        if (!cancelled) {
          setResult({
            key: resultKey,
            counts: result.genreCounts.map(row => ({ genre: row.value, count: row.albumCount })),
          });
        }
      }).catch(() => {});
    }, NEW_RELEASE_GENRE_COUNTS_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [anchorServerId, enabled, feedReady, resultKey]);

  return enabled && result.key === resultKey ? result.counts : [];
}
