import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import {
  coverTrafficBeginGridPagination,
  coverTrafficEndGridPagination,
  coverTrafficGridPaginationDepth,
} from '../cover/coverTraffic';
import { coverEnsureQueueBacklog, coverEnsureResumePump, coverEnsureSubscribeBacklogDrain } from '../cover/ensureQueue';
import { dedupeById } from '../utils/dedupeById';
import { albumBrowseCompScanComplete, albumBrowseCompFilterClientOnly } from '../utils/library/albumCompilation';
import type { AlbumCompFilter } from '../utils/library/albumCompilation';
import {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  applyAlbumBrowseClientFilters,
  fetchAlbumBrowseGenreOptions,
  fetchAlbumBrowsePage,
  fetchLocalAlbumCatalogChunk,
  type AlbumBrowseQuery,
  type GenreFilterOption,
} from '../utils/library/albumBrowseLoad';
import { libraryScopeForServer } from '../api/subsonicClient';
import {
  ALBUM_YEAR_FILTER_DEBOUNCE_MS,
  resolveAlbumYearBounds,
} from '../utils/library/albumYearFilter';
import { loadOfflineAlbumBrowseInitial } from '../utils/offline/offlineAlbumBrowseCatalog';
import { useOfflineBrowseReloadToken } from './useOfflineBrowseReloadToken';
import {
  fetchAlbumBrowseCatalogChunk,
  mergeAlbumCatalogChunk,
} from '../utils/library/albumBrowseCatalogChunk';
import { useOfflineBrowseContext } from './useOfflineBrowseContext';
import { useClientSliceInfiniteScroll } from './useClientSliceInfiniteScroll';
import { useDebouncedValue } from './useDebouncedValue';
import { useInpageScrollSentinel } from './useInpageScrollSentinel';

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
  const libraryScopeActive = libraryScopeForServer(serverId) != null;
  const narrowGenreList = yearFilterActive || losslessOnly || starredOnly || compFilterActive;
  /** When true, GenreFilterBar uses `genreCatalogOptions` instead of server `getGenres()`. */
  const genreCatalogActive = narrowGenreList || (indexEnabled && libraryScopeActive);

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
      const pageResult = await fetchAlbumBrowsePage(
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
            else setLoading(false);
          },
        },
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

  useEffect(() => {
    let cancelled = false;
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

    void (async () => {
      if (offlineBrowseActive) {
        const generation = ++loadGenerationRef.current;
        if (cancelled || generation !== loadGenerationRef.current) return;
        setBrowseMode('slice');
        try {
          const first = await loadOfflineAlbumBrowseInitial(
            serverId,
            browseQuery,
            CATALOG_CHUNK_SIZE,
            starredOverrides,
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          setAlbums(first.albums);
          catalogOffsetRef.current = first.albums.length;
          setCatalogHasMore(first.hasMore);
        } catch {
          setAlbums([]);
          setCatalogHasMore(false);
        }
        setLoading(false);
        return;
      }
      if (indexEnabled && serverId) {
        const generation = ++loadGenerationRef.current;
        coverTrafficBeginGridPagination();
        try {
          const first = await fetchLocalAlbumCatalogChunk(
            serverId,
            indexEnabled,
            browseQuery,
            0,
            CATALOG_CHUNK_SIZE,
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          if (first != null) {
            setBrowseMode('slice');
            setAlbums(first.albums);
            catalogOffsetRef.current = first.albums.length;
            setCatalogHasMore(first.hasMore);
            setLoading(false);
            return;
          }
        } finally {
          coverTrafficEndGridPagination();
          coverEnsureResumePump();
        }
      }
      if (cancelled) return;
      setBrowseMode('page');
      await loadBrowse(browseQuery, 0, false);
    })();

    return () => {
      cancelled = true;
    };
    // starredOverrides is read to seed star state during the load, but the browse
    // list must not reload on every star toggle — it is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseQuery, indexEnabled, offlineBrowseActive, offlineBrowseReloadTs, serverId, loadBrowse, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!genreCatalogActive) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGenreCatalogOptions(null);
      return;
    }
    let cancelled = false;
    void fetchAlbumBrowseGenreOptions(serverId, indexEnabled, browseQueryWithoutGenre).then(options => {
      if (!cancelled) setGenreCatalogOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, [
    genreCatalogActive,
    serverId,
    indexEnabled,
    browseQueryWithoutGenre,
    musicLibraryFilterVersion,
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
