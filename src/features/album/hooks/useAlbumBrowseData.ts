import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  coverTrafficBeginGridPagination,
  coverTrafficEndGridPagination,
  coverTrafficGridPaginationDepth,
} from '@/cover/coverTraffic';
import { coverEnsureQueueBacklog, coverEnsureResumePump, coverEnsureSubscribeBacklogDrain } from '@/cover/ensureQueue';
import { dedupeById } from '@/lib/util/dedupeById';
import { albumBrowseCompScanComplete, albumBrowseCompFilterClientOnly } from '@/lib/library/albumCompilation';
import type { AlbumCompFilter } from '@/lib/library/albumCompilation';
import {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  applyAlbumBrowseClientFilters,
  fetchAlbumBrowseGenreOptions,
  fetchAlbumBrowsePage,
  fetchLocalAlbumCatalogChunk,
  albumBrowseBootstrapEligible,
  type AlbumBrowseQuery,
  type GenreFilterOption,
} from '@/lib/library/albumBrowseLoad';
import { libraryScopeIsActive } from '@/lib/api/subsonicClient';
import {
  ALBUM_YEAR_FILTER_DEBOUNCE_MS,
  resolveAlbumYearBounds,
} from '@/lib/library/albumYearFilter';
import {
  fetchOfflineLocalAlbumGenreOptions,
  loadOfflineAlbumBrowseInitial,
  offlineLocalBrowseEnabled,
  useOfflineBrowseContext,
  useOfflineBrowseReloadToken,
} from '@/features/offline';
import { useOfflineLocalBrowseReloadKey } from '@/store/localPlaybackBrowseRevision';
import { useOfflineLocalLibrarySyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import {
  fetchAlbumBrowseCatalogChunk,
  mergeAlbumCatalogChunk,
} from '@/features/album/utils/albumBrowseCatalogChunk';
import { useClientSliceInfiniteScroll } from '@/lib/hooks/useClientSliceInfiniteScroll';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';
import {
  albumBrowseTimed,
  emitAlbumBrowseDebug,
} from '@/lib/library/albumBrowseDebug';
import { scheduleAlbumBrowseBackgroundWork } from '@/lib/library/albumBrowseBackground';
import {
  ALBUM_BROWSE_BOOTSTRAP_CHUNK,
  albumBrowseCatalogCacheKey,
  albumBrowseCatalogInflight,
  albumBrowseInitialLoadKey,
  albumBrowseOnlineCatalogKey,
  fetchAlbumBrowseCatalogDeduped,
  readAlbumBrowseCatalogCache,
  storeAlbumBrowseCatalogCache,
} from '@/lib/library/albumBrowseInflight';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';

const PAGE_SIZE = 30;
const CLIENT_SLICE_PAGE_SIZE = 60;
/** Local-index catalog buffer grows by this many albums per background SQL chunk. */
const CATALOG_CHUNK_SIZE = 200;
/** Wait for visible-row cover ensures to drain before fetching the next SQL page (network mode). */
const LOAD_MORE_COVER_BACKLOG_MAX = 12;

type AlbumBrowseMode = 'slice' | 'page';

export type UseAlbumBrowseDataArgs = {
  serverId: string;
  indexEnabled: boolean;
  musicLibraryFilterVersion: number;
  sort: AlbumBrowseQuery['sort'];
  selectedGenres: string[];
  yearFrom: string;
  yearTo: string;
  losslessOnly: boolean;
  starredOnly: boolean;
  compFilter: AlbumCompFilter;
  starredOverrides: Record<string, boolean>;
  /** IntersectionObserver scroll root (Albums in-page viewport). */
  getScrollRoot?: () => HTMLElement | null;
  /** Bumps when the scroll root mounts so the sentinel observer can rebind. */
  scrollRootEl?: HTMLElement | null;
  /** Bootstrap visible slice size when restoring scroll after album-detail back. */
  restoreDisplayCount?: number;
};

function resolveHasMoreAfterPage(
  page: { albums: SubsonicAlbum[]; hasMore: boolean },
  append: boolean,
  prevCount: number,
  mergedCount: number,
): boolean {
  if (page.albums.length === 0) return false;
  if (append && mergedCount === prevCount) return false;
  return page.hasMore;
}

export function useAlbumBrowseData({
  serverId,
  indexEnabled,
  musicLibraryFilterVersion,
  sort,
  selectedGenres,
  yearFrom,
  yearTo,
  losslessOnly,
  starredOnly,
  compFilter,
  starredOverrides,
  getScrollRoot,
  scrollRootEl,
  restoreDisplayCount,
}: UseAlbumBrowseDataArgs) {
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const offlineLocalBrowseReloadKey = useOfflineLocalBrowseReloadKey(
    serverId,
    offlineBrowseActive,
  );
  const librarySyncRevision = useOfflineLocalLibrarySyncRevision(serverId ?? null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [browseMode, setBrowseMode] = useState<AlbumBrowseMode>('page');
  const [genreCatalogOptions, setGenreCatalogOptions] = useState<GenreFilterOption[] | null>(null);

  const yearFields = useMemo(() => ({ from: yearFrom, to: yearTo }), [yearFrom, yearTo]);
  const debouncedYearFields = useDebouncedValue(yearFields, ALBUM_YEAR_FILTER_DEBOUNCE_MS);

  const { active: yearFilterActive, bounds: yearFilterBounds } = useMemo(
    () => resolveAlbumYearBounds(debouncedYearFields.from, debouncedYearFields.to),
    [debouncedYearFields.from, debouncedYearFields.to],
  );

  const browseQuery = useMemo<AlbumBrowseQuery>(() => ({
    sort,
    genres: selectedGenres,
    year: yearFilterActive ? yearFilterBounds : undefined,
    losslessOnly,
    starredOnly,
    compFilter,
  }), [sort, selectedGenres, yearFilterActive, yearFilterBounds, losslessOnly, starredOnly, compFilter]);

  const browseQueryWithoutGenre = useMemo<AlbumBrowseQuery>(() => ({
    sort,
    genres: [],
    year: yearFilterActive ? yearFilterBounds : undefined,
    losslessOnly,
    starredOnly,
    compFilter,
  }), [sort, yearFilterActive, yearFilterBounds, losslessOnly, starredOnly, compFilter]);

  const catalogLoadKey = useMemo(
    () => {
      const base = albumBrowseInitialLoadKey(
        serverId,
        musicLibraryFilterVersion,
        browseQuery,
        offlineBrowseActive,
      );
      // Online index browse re-keys on the library sync revision so a completed
      // resync surfaces renamed/pruned albums without an app restart; offline
      // browse already re-keys via its own (sync-driven) reload key.
      if (!offlineBrowseActive) return albumBrowseOnlineCatalogKey(base, librarySyncRevision);
      return `${base}\0${offlineLocalBrowseReloadKey}`;
    },
    [serverId, musicLibraryFilterVersion, browseQuery, offlineBrowseActive, offlineLocalBrowseReloadKey, librarySyncRevision],
  );

  const compFilterActive = compFilter !== 'all';
  const compFilterClientOnly = albumBrowseCompFilterClientOnly(compFilter, browseMode);

  const visibleAlbums = useMemo(
    () => applyAlbumBrowseClientFilters(albums, browseQuery, starredOverrides, browseMode),
    [albums, browseQuery, starredOverrides, browseMode],
  );

  const {
    visibleCount,
    loadingMore: sliceLoadingMore,
    loadMore: sliceLoadMore,
  } = useClientSliceInfiniteScroll({
    pageSize: CLIENT_SLICE_PAGE_SIZE,
    resetDeps: [
      browseMode,
      sort,
      selectedGenres,
      yearFilterActive,
      yearFilterBounds,
      losslessOnly,
      starredOnly,
      compFilter,
      musicLibraryFilterVersion,
      serverId,
    ],
    getScrollRoot,
    scrollRootEl,
    restoreDisplayCount,
  });

  const displayAlbums = useMemo(() => {
    if (browseMode !== 'slice') return visibleAlbums;
    return visibleAlbums.slice(0, visibleCount);
  }, [browseMode, visibleAlbums, visibleCount]);

  const genreFiltered = albumBrowseHasGenreFilter(browseQuery);
  const serverFilterActive = albumBrowseHasServerFilters(browseQuery);
  const libraryScopeActive = libraryScopeIsActive(serverId);
  const narrowGenreList = yearFilterActive || losslessOnly || starredOnly || compFilterActive;
  /** When true, GenreFilterBar uses `genreCatalogOptions` instead of server `getGenres()`. */
  const genreCatalogActive =
    narrowGenreList
    || (indexEnabled && libraryScopeActive)
    || (offlineBrowseActive && !!serverId && offlineLocalBrowseEnabled(serverId));

  const compScanExhausted = useMemo(
    () => compFilterClientOnly && !genreFiltered
      && albumBrowseCompScanComplete(albums, compFilter, hasMore),
    [compFilterClientOnly, genreFiltered, albums, compFilter, hasMore],
  );

  const pendingClientFilterMatch =
    compFilterClientOnly && visibleAlbums.length === 0 && hasMore && !genreFiltered && !compScanExhausted;

  const gridHasMore = browseMode === 'slice'
    ? visibleCount < visibleAlbums.length || catalogHasMore
    : hasMore && !genreFiltered;

  const gridLoadingMore = browseMode === 'slice'
    ? sliceLoadingMore || catalogLoadingMore
    : loadingMore;

  const loadGenerationRef = useRef(0);
  const pageRef = useRef(0);
  const catalogOffsetRef = useRef(0);
  const catalogLoadingRef = useRef(false);
  const loadingRef = useRef(false);
  const loadPendingRef = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});
  const sentinelIntersectingRef = useRef(false);
  const browseModeRef = useRef(browseMode);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  browseModeRef.current = browseMode;

  useEffect(() => {
    while (coverTrafficGridPaginationDepth() > 0) {
      coverTrafficEndGridPagination();
    }
    coverEnsureResumePump();
  }, []);

  useEffect(() => {
    return coverEnsureSubscribeBacklogDrain(() => {
      if (browseModeRef.current !== 'page') return;
      if (!sentinelIntersectingRef.current) return;
      if (loadingRef.current || loadPendingRef.current) return;
      if (coverEnsureQueueBacklog() > LOAD_MORE_COVER_BACKLOG_MAX) return;
      loadMoreRef.current();
    });
  }, []);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const loadCatalogChunk = useCallback(async (
    query: AlbumBrowseQuery,
    offset: number,
    append: boolean,
  ) => {
    if (catalogLoadingRef.current) return;
    const generation = loadGenerationRef.current;
    catalogLoadingRef.current = true;
    setCatalogLoadingMore(true);
    try {
      const chunk = await fetchAlbumBrowseCatalogChunk(
        serverId,
        indexEnabled,
        query,
        offset,
        CATALOG_CHUNK_SIZE,
        starredOverrides,
      );
      if (generation !== loadGenerationRef.current || chunk == null) return;
      setAlbums(prev => {
        const { albums: next, offset: nextOffset } = mergeAlbumCatalogChunk(prev, chunk, append);
        catalogOffsetRef.current = nextOffset;
        return next;
      });
      setCatalogHasMore(chunk.hasMore);
    } finally {
      catalogLoadingRef.current = false;
      if (generation === loadGenerationRef.current) {
        setCatalogLoadingMore(false);
      }
    }
    // offlineBrowseActive is an intentional re-create trigger so the catalog
    // reloads from the right source when offline browse toggles; the loader reads
    // the active mode internally rather than referencing the flag directly here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexEnabled, offlineBrowseActive, serverId, starredOverrides]);

  const loadBrowse = useCallback(async (
    query: AlbumBrowseQuery,
    offset: number,
    append = false,
  ) => {
    const generation = ++loadGenerationRef.current;
    loadingRef.current = true;
    loadPendingRef.current = true;
    coverTrafficBeginGridPagination();
    if (append) setLoadingMore(true);
    else setLoading(true);
    const applyPage = (pageResult: { albums: SubsonicAlbum[]; hasMore: boolean }) => {
      if (generation !== loadGenerationRef.current) return;
      if (append) {
        setAlbums(prev => {
          const merged = dedupeById([...prev, ...pageResult.albums]);
          setHasMore(resolveHasMoreAfterPage(pageResult, true, prev.length, merged.length));
          return merged;
        });
      } else {
        setAlbums(pageResult.albums);
        setHasMore(resolveHasMoreAfterPage(pageResult, false, 0, pageResult.albums.length));
      }
    };
    try {
      const pageResult = await albumBrowseTimed(
        append ? 'page_browse_more' : 'page_browse',
        () => fetchAlbumBrowsePage(
          serverId,
          indexEnabled,
          query,
          offset,
          PAGE_SIZE,
          {
            onPartial: partial => {
              if (generation !== loadGenerationRef.current) return;
              applyPage(partial);
              loadingRef.current = false;
              if (append) setLoadingMore(false);
              else {
                setLoading(false);
                emitAlbumBrowseDebug('loading_false', {
                  source: 'page_browse_partial',
                  albumCount: partial.albums.length,
                });
              }
            },
          },
        ),
        { offset, pageSize: PAGE_SIZE, append },
      );
      applyPage(pageResult);
    } finally {
      coverTrafficEndGridPagination();
      coverEnsureResumePump();
      if (generation === loadGenerationRef.current) {
        loadingRef.current = false;
        loadPendingRef.current = false;
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [indexEnabled, serverId]);

  useLayoutEffect(() => {
    const cached = readAlbumBrowseCatalogCache(catalogLoadKey);
    if (!cached) return;
    pageRef.current = 0;
    catalogOffsetRef.current = cached.albums.length;
    loadPendingRef.current = false;
    catalogLoadingRef.current = false;
    // React Compiler set-state-in-effect rule: local state synced from the catalog cache before paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(0);
    setBrowseMode('slice');
    setAlbums(cached.albums);
    setHasMore(true);
    setCatalogHasMore(cached.hasMore);
    setCatalogLoadingMore(false);
    setLoading(false);
    emitAlbumBrowseDebug('load_effect_cache_hit', { albumCount: cached.albums.length, sync: true });
  }, [catalogLoadKey]);

  useEffect(() => {
    let cancelled = false;
    const loadKey = catalogLoadKey;

    if (readAlbumBrowseCatalogCache(loadKey)) {
      return () => {
        cancelled = true;
      };
    }

    const bootKey = albumBrowseCatalogCacheKey(
      loadKey,
      ALBUM_BROWSE_BOOTSTRAP_CHUNK,
      CATALOG_CHUNK_SIZE,
    );
    const joinInflight =
      albumBrowseCatalogInflight(loadKey)
      || (albumBrowseBootstrapEligible(browseQuery) && albumBrowseCatalogInflight(bootKey));
    if (!joinInflight) {
      pageRef.current = 0;
      catalogOffsetRef.current = 0;
      loadPendingRef.current = false;
      catalogLoadingRef.current = false;
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPage(0);
      setAlbums([]);
      setHasMore(true);
      setCatalogHasMore(false);
      setCatalogLoadingMore(false);
      setLoading(true);
    } else {
      emitAlbumBrowseDebug('load_effect_join_inflight', {});
    }

    const generation = ++loadGenerationRef.current;

    emitAlbumBrowseDebug('load_effect_start', {
      serverId,
      indexEnabled,
      libraryFilterVersion: musicLibraryFilterVersion,
      libraryScopeCount: librarySelectionForServer(serverId).length,
      offlineBrowseActive,
      joinInflight,
      sort: browseQuery.sort,
      genreCount: browseQuery.genres.length,
      yearFilter: yearFilterActive,
      losslessOnly,
      starredOnly,
      compFilter,
    });

    void (async () => {
      if (offlineBrowseActive) {
        emitAlbumBrowseDebug('load_branch', { mode: 'offline' });
        if (cancelled || generation !== loadGenerationRef.current) return;
        setBrowseMode('slice');
        try {
          const first = await albumBrowseTimed(
            'offline_catalog_chunk',
            () => loadOfflineAlbumBrowseInitial(
              serverId,
              browseQuery,
              CATALOG_CHUNK_SIZE,
              starredOverrides,
            ),
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          setAlbums(first.albums);
          catalogOffsetRef.current = first.albums.length;
          setCatalogHasMore(first.hasMore);
          emitAlbumBrowseDebug('load_effect_done', {
            browseMode: 'slice',
            albumCount: first.albums.length,
            hasMore: first.hasMore,
          });
        } catch {
          setAlbums([]);
          setCatalogHasMore(false);
          emitAlbumBrowseDebug('load_effect_error', { browseMode: 'slice' });
        }
        setLoading(false);
        emitAlbumBrowseDebug('loading_false', { source: 'offline' });
        return;
      }
      if (indexEnabled && serverId) {
        emitAlbumBrowseDebug('load_branch', { mode: 'slice_try' });
        coverTrafficBeginGridPagination();
        try {
          const bootstrap = albumBrowseBootstrapEligible(browseQuery);
          if (bootstrap) {
            const bootKey = albumBrowseCatalogCacheKey(
              loadKey,
              ALBUM_BROWSE_BOOTSTRAP_CHUNK,
              CATALOG_CHUNK_SIZE,
            );
            const preview = await fetchAlbumBrowseCatalogDeduped(bootKey, () =>
              albumBrowseTimed(
                'local_catalog_bootstrap',
                () => fetchLocalAlbumCatalogChunk(
                  serverId,
                  indexEnabled,
                  browseQuery,
                  0,
                  ALBUM_BROWSE_BOOTSTRAP_CHUNK,
                ),
                { chunkSize: ALBUM_BROWSE_BOOTSTRAP_CHUNK },
              ),
            );
            if (cancelled || generation !== loadGenerationRef.current) return;
            if (preview != null && preview.albums.length > 0) {
              setBrowseMode('slice');
              setAlbums(preview.albums);
              catalogOffsetRef.current = preview.albums.length;
              const needsTail =
                preview.hasMore && preview.albums.length < CATALOG_CHUNK_SIZE;
              setCatalogHasMore(needsTail || preview.hasMore);
              setLoading(false);
              emitAlbumBrowseDebug('loading_false', {
                source: 'slice_bootstrap',
                albumCount: preview.albums.length,
              });
              emitAlbumBrowseDebug('load_effect_done', {
                browseMode: 'slice',
                bootstrap: true,
                albumCount: preview.albums.length,
                hasMore: preview.hasMore,
              });
              if (needsTail) {
                const tailOffset = preview.albums.length;
                const tailSize = CATALOG_CHUNK_SIZE - tailOffset;
                scheduleAlbumBrowseBackgroundWork(() => {
                  void (async () => {
                    catalogLoadingRef.current = true;
                    setCatalogLoadingMore(true);
                    try {
                      const tail = await fetchAlbumBrowseCatalogDeduped(loadKey, () =>
                        albumBrowseTimed(
                          'local_catalog_tail',
                          () => fetchLocalAlbumCatalogChunk(
                            serverId,
                            indexEnabled,
                            browseQuery,
                            tailOffset,
                            tailSize,
                          ),
                          { offset: tailOffset, chunkSize: tailSize },
                        ),
                      );
                      if (
                        cancelled
                        || generation !== loadGenerationRef.current
                        || tail == null
                      ) return;
                      setAlbums(prev => {
                        const merged = dedupeById([...prev, ...tail.albums]);
                        catalogOffsetRef.current = merged.length;
                        storeAlbumBrowseCatalogCache(loadKey, {
                          albums: merged,
                          hasMore: tail.hasMore,
                        });
                        return merged;
                      });
                      setCatalogHasMore(tail.hasMore);
                      emitAlbumBrowseDebug('catalog_tail_done', {
                        albumCount: tail.albums.length,
                        totalOffset: tailOffset + tail.albums.length,
                      });
                    } finally {
                      catalogLoadingRef.current = false;
                      if (generation === loadGenerationRef.current) {
                        setCatalogLoadingMore(false);
                      }
                    }
                  })();
                });
              } else {
                storeAlbumBrowseCatalogCache(loadKey, preview);
              }
              return;
            }
          }
          const first = await fetchAlbumBrowseCatalogDeduped(loadKey, () =>
            albumBrowseTimed(
              'local_catalog_chunk',
              () => fetchLocalAlbumCatalogChunk(
                serverId,
                indexEnabled,
                browseQuery,
                0,
                CATALOG_CHUNK_SIZE,
              ),
            ),
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          if (first != null) {
            setBrowseMode('slice');
            setAlbums(first.albums);
            catalogOffsetRef.current = first.albums.length;
            setCatalogHasMore(first.hasMore);
            setLoading(false);
            emitAlbumBrowseDebug('loading_false', { source: 'slice', albumCount: first.albums.length });
            emitAlbumBrowseDebug('load_effect_done', {
              browseMode: 'slice',
              albumCount: first.albums.length,
              hasMore: first.hasMore,
            });
            return;
          }
          emitAlbumBrowseDebug('slice_fallback', { reason: 'local_chunk_null' });
        } finally {
          coverTrafficEndGridPagination();
          coverEnsureResumePump();
        }
      }
      if (cancelled) return;
      emitAlbumBrowseDebug('load_branch', { mode: 'page' });
      setBrowseMode('page');
      await loadBrowse(browseQuery, 0, false);
      if (!cancelled) {
        emitAlbumBrowseDebug('load_effect_done', { browseMode: 'page' });
      }
    })();

    return () => {
      cancelled = true;
    };
    // starredOverrides is read to seed star state during the load, but the browse
    // list must not reload on every star toggle — it is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogLoadKey, browseQuery, indexEnabled, offlineBrowseActive, offlineBrowseReloadTs, serverId, loadBrowse, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!genreCatalogActive) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGenreCatalogOptions(null);
      return;
    }
    // Defer genre catalog until the first album chunk is loaded — avoids contending
    // with `library_advanced_search` on the shared spawn_blocking pool at open.
    if (loading) return;
    let cancelled = false;
    void albumBrowseTimed(
      'genre_options',
      () => offlineBrowseActive && serverId && offlineLocalBrowseEnabled(serverId)
        ? fetchOfflineLocalAlbumGenreOptions(serverId, browseQueryWithoutGenre, starredOverrides)
        : fetchAlbumBrowseGenreOptions(serverId, indexEnabled, browseQueryWithoutGenre),
    ).then(options => {
      if (!cancelled) {
        setGenreCatalogOptions(options);
        emitAlbumBrowseDebug('genre_options_set', { count: options.length });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    genreCatalogActive,
    loading,
    serverId,
    indexEnabled,
    browseQueryWithoutGenre,
    musicLibraryFilterVersion,
    offlineBrowseActive,
    starredOverrides,
  ]);

  const loadMorePage = useCallback(() => {
    if (loadingRef.current || loadPendingRef.current || !hasMore || genreFiltered) return;
    if (coverEnsureQueueBacklog() > LOAD_MORE_COVER_BACKLOG_MAX) return;
    if (compFilterClientOnly && visibleAlbums.length === 0
      && albumBrowseCompScanComplete(albums, compFilter, hasMore)) {
      return;
    }
    const next = pageRef.current + 1;
    pageRef.current = next;
    setPage(next);
    void loadBrowse(browseQuery, next * PAGE_SIZE, true);
  }, [
    hasMore,
    browseQuery,
    loadBrowse,
    genreFiltered,
    compFilterClientOnly,
    visibleAlbums.length,
    albums,
    compFilter,
  ]);

  const loadMoreGrid = useCallback(() => {
    if (visibleCount < visibleAlbums.length) {
      sliceLoadMore();
      return;
    }
    if (catalogHasMore && !catalogLoadingRef.current) {
      void loadCatalogChunk(browseQuery, catalogOffsetRef.current, true);
    }
  }, [
    visibleCount,
    visibleAlbums.length,
    catalogHasMore,
    sliceLoadMore,
    loadCatalogChunk,
    browseQuery,
  ]);

  const loadMore = useCallback(() => {
    if (browseMode === 'slice') {
      loadMoreGrid();
      return;
    }
    loadMorePage();
  }, [browseMode, loadMoreGrid, loadMorePage]);

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  loadMoreRef.current = loadMore;

  useEffect(() => {
    if (browseMode !== 'page') return;
    if (!pendingClientFilterMatch || loadingRef.current || loadPendingRef.current) return;
    loadMorePage();
  }, [browseMode, pendingClientFilterMatch, loading, loadMorePage]);

  useEffect(() => {
    if (browseMode !== 'slice') return;
    if (!sentinelIntersectingRef.current) return;
    if (visibleCount >= visibleAlbums.length - CLIENT_SLICE_PAGE_SIZE
      && catalogHasMore
      && !catalogLoadingRef.current) {
      void loadCatalogChunk(browseQuery, catalogOffsetRef.current, true);
    }
  }, [
    browseMode,
    visibleCount,
    visibleAlbums.length,
    catalogHasMore,
    loadCatalogChunk,
    browseQuery,
  ]);

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: gridHasMore,
    getScrollRoot,
    scrollRootEl,
    onIntersect: () => loadMoreRef.current(),
    drainSignal: gridLoadingMore,
    intersectingRef: sentinelIntersectingRef,
  });

  return {
    albums,
    loading,
    loadingMore: gridLoadingMore,
    hasMore: gridHasMore,
    displayAlbums,
    browseMode,
    PAGE_SIZE,
    browseQuery,
    browseQueryWithoutGenre,
    visibleAlbums,
    genreFiltered,
    serverFilterActive,
    narrowGenreList,
    genreCatalogActive,
    genreCatalogOptions,
    yearFilterActive,
    debouncedYearFields,
    compFilterActive,
    compFilterClientOnly,
    compScanExhausted,
    pendingClientFilterMatch,
    loadMore,
    bindLoadMoreSentinel,
  };
}
