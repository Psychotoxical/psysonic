import { useEffect, useState } from 'react';
import { libraryGetStatus } from '@/lib/api/library';

/**
 * Server `ignoredArticles` (Navidrome `getArtists` watermark) for the active
 * server's local index, used to bucket artist/composer letters the same way the
 * index sorts `name_sort`. Falls back to `null` (Navidrome default list) when
 * the index is disabled, the server omits the field, or the lookup fails.
 *
 * One lightweight read per server change — `ignoredArticles` rarely changes, so
 * we deliberately avoid the polling that `useLibraryIndexSync` does.
 */
export function useLibraryIgnoredArticles(
  serverId: string | null | undefined,
  enabled = true,
): string | null {
  const [ignoredArticles, setIgnoredArticles] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !serverId) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIgnoredArticles(null);
      return;
    }
    let cancelled = false;
    void libraryGetStatus(serverId)
      .then(status => {
        if (!cancelled) setIgnoredArticles(status.ignoredArticles ?? null);
      })
      .catch(() => {
        if (!cancelled) setIgnoredArticles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, enabled]);

  return ignoredArticles;
}
