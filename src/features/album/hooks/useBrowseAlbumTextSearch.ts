import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { useEffect, useRef, useState } from 'react';
import {
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
  BROWSE_TEXT_DEBOUNCE_RACE_MS,
  browseRaceCountsAlbums,
  raceBrowseWithLocalFallback,
  runLocalBrowseAlbums,
  runNetworkBrowseAlbums,
} from '@/lib/library/browseTextSearch';
import { useOfflineBrowseContext } from '@/features/offline';
import { offlineLocalBrowseEnabled, searchOfflineLocalAlbums } from '@/features/offline';

/**
 * Debounced album title search with local-vs-network race when the
 * library index is enabled; network-only when it is not.
 */
export function useBrowseAlbumTextSearch(
  filter: string,
  indexEnabled: boolean,
  serverId: string | null | undefined,
  losslessOnly = false,
) {
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const [debouncedFilter, setDebouncedFilter] = useState('');
  const [textSearchAlbums, setTextSearchAlbums] = useState<SubsonicAlbum[] | null>(null);
  const [textSearchLoading, setTextSearchLoading] = useState(false);
  const searchGenRef = useRef(0);

  useEffect(() => {
    const ms = indexEnabled ? BROWSE_TEXT_DEBOUNCE_RACE_MS : BROWSE_TEXT_DEBOUNCE_NETWORK_MS;
    const timer = window.setTimeout(() => setDebouncedFilter(filter.trim()), ms);
    return () => window.clearTimeout(timer);
  }, [filter, indexEnabled]);

  useEffect(() => {
    const q = debouncedFilter;
    if (!q || !serverId) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTextSearchAlbums(null);
      setTextSearchLoading(false);
      return;
    }

    const gen = ++searchGenRef.current;
    const isStale = () => gen !== searchGenRef.current;
    setTextSearchLoading(true);

    void (async () => {
      if (offlineBrowseActive) {
        const albums = offlineLocalBrowseEnabled(serverId)
          ? await searchOfflineLocalAlbums(serverId, q, losslessOnly)
          : [];
        if (isStale()) return;
        setTextSearchAlbums(albums);
        setTextSearchLoading(false);
        return;
      }
      if (!indexEnabled) {
        const albums = await runNetworkBrowseAlbums(q);
        if (isStale()) return;
        setTextSearchAlbums(albums);
        setTextSearchLoading(false);
        return;
      }

      const outcome = await raceBrowseWithLocalFallback(
        isStale,
        () => runLocalBrowseAlbums(serverId, q, undefined, losslessOnly),
        () => runNetworkBrowseAlbums(q),
        {
          surface: 'albums_browse',
          query: q,
          indexEnabled,
          counts: browseRaceCountsAlbums,
        },
      );
      if (isStale()) return;
      setTextSearchAlbums(outcome?.result ?? null);
      setTextSearchLoading(false);
    })();
  }, [debouncedFilter, indexEnabled, offlineBrowseActive, serverId, losslessOnly]);

  const effectiveFilter = textSearchAlbums != null ? '' : filter;
  return { textSearchAlbums, textSearchLoading, effectiveFilter };
}
