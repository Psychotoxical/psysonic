import type { SubsonicArtist } from '../api/subsonicTypes';
import { useEffect, useRef, useState } from 'react';
import {
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
  BROWSE_TEXT_DEBOUNCE_RACE_MS,
  browseRaceCountsArtists,
  raceBrowseWithLocalFallback,
  runLocalBrowseArtists,
  runNetworkBrowseArtists,
  type LibrarySearchSurface,
} from '../utils/library/browseTextSearch';
import { useOfflineBrowseContext } from './useOfflineBrowseContext';
import { offlineLocalBrowseEnabled, searchOfflineLocalArtists } from '../utils/offline/offlineLocalBrowse';

/**
 * Debounced artist/composer name search with local-vs-network race when the
 * library index is enabled. Returns `textSearchArtists` when a raced query is
 * active; callers should pass `effectiveFilter` (empty while raced) into their
 * local filter hook so the query is not applied twice.
 */
export function useBrowseArtistTextSearch(
  filter: string,
  indexEnabled: boolean,
  serverId: string | null | undefined,
  surface: LibrarySearchSurface = 'artists_browse',
) {
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const [debouncedFilter, setDebouncedFilter] = useState('');
  const [textSearchArtists, setTextSearchArtists] = useState<SubsonicArtist[] | null>(null);
  const [textSearchLoading, setTextSearchLoading] = useState(false);
  const searchGenRef = useRef(0);

  useEffect(() => {
    const ms = indexEnabled ? BROWSE_TEXT_DEBOUNCE_RACE_MS : BROWSE_TEXT_DEBOUNCE_NETWORK_MS;
    const timer = window.setTimeout(() => setDebouncedFilter(filter.trim()), ms);
    return () => window.clearTimeout(timer);
  }, [filter, indexEnabled]);

  useEffect(() => {
    const q = debouncedFilter;
    if (!q || !indexEnabled || !serverId) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTextSearchArtists(null);
      setTextSearchLoading(false);
      return;
    }

    const gen = ++searchGenRef.current;
    const isStale = () => gen !== searchGenRef.current;
    setTextSearchLoading(true);

    void (async () => {
      if (offlineBrowseActive) {
        const artists = offlineLocalBrowseEnabled(serverId)
          ? await searchOfflineLocalArtists(serverId, q)
          : [];
        if (isStale()) return;
        setTextSearchArtists(artists);
        setTextSearchLoading(false);
        return;
      }
      const outcome = await raceBrowseWithLocalFallback(
        isStale,
        () => runLocalBrowseArtists(serverId, q),
        () => runNetworkBrowseArtists(q),
        {
          surface,
          query: q,
          indexEnabled,
          counts: browseRaceCountsArtists,
        },
      );
      if (isStale()) return;
      setTextSearchArtists(outcome?.result ?? null);
      setTextSearchLoading(false);
    })();
  }, [debouncedFilter, indexEnabled, offlineBrowseActive, serverId, surface]);

  const effectiveFilter = textSearchArtists != null ? '' : filter;
  return { textSearchArtists, textSearchLoading, effectiveFilter };
}
