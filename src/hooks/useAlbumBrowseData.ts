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
import { albumBrowseCompScanComplete } from '../utils/library/albumCompilation';
import type { AlbumCompFilter } from '../utils/library/albumCompilation';
import {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  fetchAlbumBrowseGenreOptions,
  fetchAlbumBrowsePage,
  filterAlbumsByCompilation,
  filterAlbumsByStarred,
  type AlbumBrowseQuery,
  type GenreFilterOption,
} from '../utils/library/albumBrowseLoad';
import {
  ALBUM_YEAR_FILTER_DEBOUNCE_MS,
  resolveAlbumYearBounds,
} from '../utils/library/albumYearFilter';
import { useDebouncedValue } from './useDebouncedValue';
import { useInpageScrollSentinel } from './useInpageScrollSentinel';

const PAGE_SIZE = 30;
/** Wait for visible-row cover ensures to drain before fetching the next SQL page. */
const LOAD_MORE_COVER_BACKLOG_MAX = 12;

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
}: UseAlbumBrowseDataArgs) {
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
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
  const compFilterClientOnly = compFilterActive && !indexEnabled;

  const visibleAlbums = useMemo(() => {
    let out = compFilterActive
      ? filterAlbumsByCompilation(albums, compFilter)
      : albums;
    if (starredOnly) out = filterAlbumsByStarred(out, starredOverrides);
    return out;
  }, [albums, compFilter, compFilterActive, starredOnly, starredOverrides]);

  const genreFiltered = albumBrowseHasGenreFilter(browseQuery);
  const serverFilterActive = albumBrowseHasServerFilters(browseQuery);
  const narrowGenreList = yearFilterActive || losslessOnly || starredOnly || compFilterActive;

  const compScanExhausted = useMemo(
    () => compFilterClientOnly && !genreFiltered
      && albumBrowseCompScanComplete(albums, compFilter, hasMore),
    [compFilterClientOnly, genreFiltered, albums, compFilter, hasMore],
  );

  const pendingClientFilterMatch =
    compFilterClientOnly && visibleAlbums.length === 0 && hasMore && !genreFiltered && !compScanExhausted;

  const loadGenerationRef = useRef(0);
  const pageRef = useRef(0);
  const loadingRef = useRef(false);
  /** Blocks overlapping sentinel callbacks until the current page fetch settles. */
  const loadPendingRef = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});
  const sentinelIntersectingRef = useRef(false);

  useEffect(() => {
    while (coverTrafficGridPaginationDepth() > 0) {
      coverTrafficEndGridPagination();
    }
    coverEnsureResumePump();
  }, []);

  useEffect(() => {
    return coverEnsureSubscribeBacklogDrain(() => {
      if (!sentinelIntersectingRef.current) return;
      if (loadingRef.current || loadPendingRef.current) return;
      if (coverEnsureQueueBacklog() > LOAD_MORE_COVER_BACKLOG_MAX) return;
      loadMoreRef.current();
    });
  }, []);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

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
      // Always pair begin/end — stale generations must not leak the grid hold.
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
    pageRef.current = 0;
    loadPendingRef.current = false;
    setPage(0);
    loadBrowse(browseQuery, 0, false);
  }, [browseQuery, loadBrowse, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!narrowGenreList) {
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
    narrowGenreList,
    serverId,
    indexEnabled,
    browseQueryWithoutGenre,
    musicLibraryFilterVersion,
  ]);

  const loadMore = useCallback(() => {
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

  loadMoreRef.current = loadMore;

  useEffect(() => {
    if (!pendingClientFilterMatch || loadingRef.current || loadPendingRef.current) return;
    loadMore();
  }, [pendingClientFilterMatch, loading, loadMore]);

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: !genreFiltered && hasMore,
    getScrollRoot,
    scrollRootEl,
    onIntersect: () => loadMoreRef.current(),
    drainSignal: loadingMore,
    intersectingRef: sentinelIntersectingRef,
  });

  return {
    albums,
    loading,
    loadingMore,
    hasMore,
    PAGE_SIZE,
    browseQuery,
    browseQueryWithoutGenre,
    visibleAlbums,
    genreFiltered,
    serverFilterActive,
    narrowGenreList,
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
