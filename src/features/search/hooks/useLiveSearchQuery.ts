import { useRef, useEffect, useCallback, useState, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { libraryGetStatus, subscribeLibrarySyncIdle, subscribeLibrarySyncProgress } from '@/lib/api/library';
import type { SearchResults } from '@/lib/api/subsonicTypes';
import {
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS,
  LIVE_SEARCH_DEBOUNCE_RACE_MS,
  EMPTY_SEARCH_RESULTS,
  liveSearchQueryRejected,
  mergeLiveSearchResults,
  runLocalLiveSearch,
  runNetworkLiveSearch,
} from '@/lib/library/liveSearchLocal';
import { raceLiveSearch } from '@/lib/library/searchRace';
import { libraryStatusIsReady } from '@/lib/library/libraryReady';
import {
  emitLiveSearchDebug,
  searchHitCounts,
  searchResultSamples,
} from '@/lib/library/liveSearchDebug';
import { logLibrarySearch } from '@/lib/library/libraryDevLog';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import { showToast } from '@/lib/dom/toast';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { LiveSearchScope } from '@/store/liveSearchScopeStore';
import { isLiveSearchDropdownBlocked } from '@/features/search/components/liveSearchScope';
import type { useShareSearch } from '@/features/search/hooks/useShareSearch';
import type { LiveSearchSource } from '@/features/search/components/LiveSearchDropdown';
import { useBrowseLibraryScope } from '@/store/useBrowseLibraryScope';

interface UseLiveSearchQueryParams {
  query: string;
  scope: LiveSearchScope | null;
  shareMatch: ReturnType<typeof useShareSearch>['shareMatch'];
  /** Generation counter for in-flight cancellation; the component also bumps it on route leave. */
  liveSearchGenRef: MutableRefObject<number>;
  setResults: Dispatch<SetStateAction<SearchResults | null>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSearchSource: Dispatch<SetStateAction<LiveSearchSource | null>>;
  setActiveIndex: Dispatch<SetStateAction<number>>;
}

/**
 * Runs the debounced live-search query (local-index/network race, merge, logging) and
 * pushes the results into the caller's state setters. Owns the local-ready cache that the
 * race logging reads; the overlay/keyboard/render state stays in the component.
 */
export function useLiveSearchQuery({
  query,
  scope,
  shareMatch,
  liveSearchGenRef,
  setResults,
  setOpen,
  setLoading,
  setSearchSource,
  setActiveIndex,
}: UseLiveSearchQueryParams) {
  const { t } = useTranslation();
  const serverId = useAuthStore(s => s.activeServerId);
  const browseScope = useBrowseLibraryScope();
  const browseServerId = browseScope.anchorServerId || serverId;
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const localReadyRef = useRef(false);
  const [indexIncomplete, setIndexIncomplete] = useState(false);

  const refreshIndexStatus = useCallback(async () => {
    if (!serverId || !indexEnabled) {
      localReadyRef.current = false;
      setIndexIncomplete(false);
      return;
    }
    try {
      const status = await libraryGetStatus(serverId);
      const ready = libraryStatusIsReady(status);
      localReadyRef.current = ready;
      setIndexIncomplete(!ready);
    } catch {
      localReadyRef.current = false;
      setIndexIncomplete(false);
    }
  }, [serverId, indexEnabled]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshIndexStatus();
  }, [refreshIndexStatus, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!indexEnabled || !serverId) return;
    let unlistenProgress: (() => void) | undefined;
    let unlistenIdle: (() => void) | undefined;
    const indexKey = resolveIndexKey(serverId);
    void subscribeLibrarySyncIdle(payload => {
      if (payload.serverId === indexKey) void refreshIndexStatus();
    }).then(fn => {
      unlistenIdle = fn;
    });
    void subscribeLibrarySyncProgress(p => {
      if (p.serverId === indexKey && p.kind === 'phase_changed') void refreshIndexStatus();
    }).then(fn => {
      unlistenProgress = fn;
    });
    return () => {
      unlistenIdle?.();
      unlistenProgress?.();
    };
  }, [indexEnabled, serverId, refreshIndexStatus]);

  useEffect(() => {
    if (isLiveSearchDropdownBlocked(scope)) {
      setResults(null);
      setOpen(false);
      setSearchSource(null);
      setLoading(false);
      return;
    }

    if (shareMatch) {
      setResults(null);
      setLoading(false);
      setSearchSource(null);
      setOpen(true);
      setActiveIndex(-1);
      return;
    }

    const q = query.trim();
    if (!q) {
      setResults(null);
      setOpen(false);
      setSearchSource(null);
      setLoading(false);
      return;
    }

    setSearchSource(null);
    setActiveIndex(-1);

    const abort = new AbortController();
    const debounceMs = indexEnabled ? LIVE_SEARCH_DEBOUNCE_RACE_MS : LIVE_SEARCH_DEBOUNCE_NETWORK_MS;

    const timer = window.setTimeout(() => {
      void (async () => {
        const gen = liveSearchGenRef.current;
        const isStale = () =>
          gen !== liveSearchGenRef.current || abort.signal.aborted;

        if (isStale()) return;

        setLoading(true);
        const searchT0 = performance.now();
        try {
          if (liveSearchQueryRejected(q)) {
            if (!isStale()) {
              setResults(EMPTY_SEARCH_RESULTS);
              setSearchSource(null);
              setOpen(true);
            }
            return;
          }

          const raceCtx = { epoch: gen, isStale, suppressLog: indexEnabled && !!browseServerId };

            if (browseScope.multiServer && browseServerId) {
              const local = await runLocalLiveSearch(
                browseServerId,
                q,
                raceCtx,
                browseScope.pairs,
              );
              if (isStale()) return;
              setResults(local ?? EMPTY_SEARCH_RESULTS);
              setSearchSource(local ? 'local' : null);
              setOpen(true);
              return;
            }

            if (indexEnabled && browseServerId) {
              const winner = await raceLiveSearch(
                () => runLocalLiveSearch(browseServerId, q, raceCtx, browseScope.pairs),
                () => runNetworkLiveSearch(q, abort.signal),
                isStale,
                meta => {
                  emitLiveSearchDebug('race_settled', {
                    query: q,
                    winner: meta.winner,
                    localMs: meta.localMs,
                    networkMs: meta.networkMs,
                    localHits: meta.localHits,
                    networkHits: meta.networkHits,
                  });
                  if (isStale()) return;
                  if (meta.localResult && meta.networkResult) {
                    const primary =
                      meta.winner === 'local' ? meta.localResult : meta.networkResult;
                    const supplement =
                      meta.winner === 'local' ? meta.networkResult : meta.localResult;
                    const merged = mergeLiveSearchResults(primary, supplement);
                    const primaryHits = searchHitCounts(primary);
                    const mergedHits = searchHitCounts(merged);
                    if (mergedHits !== primaryHits) {
                      setResults(merged);
                      setSearchSource(meta.winner);
                      emitLiveSearchDebug('race_merged', {
                        query: q,
                        winner: meta.winner,
                        before: primaryHits,
                        after: mergedHits,
                        samples: searchResultSamples(merged),
                      });
                    }
                  }
                },
              );
              if (isStale()) return;
              if (winner) {
                setResults(winner.result);
                setSearchSource(winner.source);
                setOpen(true);
                const samples = searchResultSamples(winner.result);
                emitLiveSearchDebug('race_winner', {
                  query: q,
                  winner: winner.source,
                  raceMs: winner.durationMs,
                  hits: searchHitCounts(winner.result),
                  samples,
                  path: 'search_race',
                  localReady: localReadyRef.current,
                });
                logLibrarySearch({
                  at: new Date().toISOString(),
                  query: q,
                  path: 'search_race',
                  surface: 'live_search',
                  durationMs: Math.round(performance.now() - searchT0),
                  debounceMs,
                  indexEnabled,
                  localReadyCached: localReadyRef.current,
                  raceWinner: winner.source,
                  raceWinnerMs: winner.durationMs,
                  counts: {
                    artists: winner.result.artists.length,
                    albums: winner.result.albums.length,
                    songs: winner.result.songs.length,
                  },
                });
                return;
              }
              showToast(t('search.liveSearchFailed'), 3200, 'error');
            } else if (serverId) {
            const network = await runNetworkLiveSearch(q, abort.signal);
            if (isStale()) return;
            if (network) {
              setResults(network);
              setSearchSource('network');
              setOpen(true);
              logLibrarySearch({
                at: new Date().toISOString(),
                query: q,
                path: 'search3',
                surface: 'live_search',
                source: 'network',
                durationMs: Math.round(performance.now() - searchT0),
                debounceMs,
                indexEnabled,
                counts: {
                  artists: network.artists.length,
                  albums: network.albums.length,
                  songs: network.songs.length,
                },
              });
            }
          }
        } catch (err) {
          if (isStale()) return;
          const name = err instanceof Error ? err.name : '';
          if (name === 'CanceledError' || name === 'AbortError') return;
          showToast(t('search.liveSearchFailed'), 3200, 'error');
        } finally {
          if (!isStale()) setLoading(false);
        }
      })();
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      abort.abort();
      liveSearchGenRef.current += 1;
    };
  }, [
    query, scope, shareMatch, serverId, browseScope.fingerprint, browseScope.multiServer, browseScope.pairs, browseServerId, indexEnabled, musicLibraryFilterVersion, t,
    liveSearchGenRef, setResults, setOpen, setLoading, setSearchSource, setActiveIndex,
  ]);

  return { indexIncomplete };
}
