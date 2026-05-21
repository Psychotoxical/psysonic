import type { SubsonicArtist } from '../api/subsonicTypes';
import { useEffect, useRef, useState } from 'react';
import {
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
  BROWSE_TEXT_DEBOUNCE_RACE_MS,
  raceBrowseWithLocalFallback,
  runLocalBrowseArtists,
  runNetworkBrowseArtists,
} from '../utils/library/browseTextSearch';

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
) {
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
      setTextSearchArtists(null);
      setTextSearchLoading(false);
      return;
    }

    const gen = ++searchGenRef.current;
    const isStale = () => gen !== searchGenRef.current;
    setTextSearchLoading(true);

    void (async () => {
      const outcome = await raceBrowseWithLocalFallback(
        isStale,
        () => runLocalBrowseArtists(serverId, q),
        () => runNetworkBrowseArtists(q),
      );
      if (isStale()) return;
      setTextSearchArtists(outcome?.result ?? null);
      setTextSearchLoading(false);
    })();
  }, [debouncedFilter, indexEnabled, serverId]);

  const effectiveFilter = textSearchArtists != null ? '' : filter;
  return { textSearchArtists, textSearchLoading, effectiveFilter };
}
