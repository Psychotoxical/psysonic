import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubsonicAlbum } from '../api/subsonicTypes';
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

const PAGE_SIZE = 30;

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
};

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
}: UseAlbumBrowseDataArgs) {
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
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

  const loadBrowse = useCallback(async (
    query: AlbumBrowseQuery,
    offset: number,
    append = false,
  ) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    const applyPage = (page: { albums: SubsonicAlbum[]; hasMore: boolean }) => {
      if (generation !== loadGenerationRef.current) return;
      if (append) setAlbums(prev => dedupeById([...prev, ...page.albums]));
      else setAlbums(page.albums);
      setHasMore(page.hasMore);
    };
    try {
      const page = await fetchAlbumBrowsePage(
        serverId,
        indexEnabled,
        query,
        offset,
        PAGE_SIZE,
        {
          onPartial: partial => {
            if (generation !== loadGenerationRef.current) return;
            applyPage(partial);
            setLoading(false);
          },
        },
      );
      applyPage(page);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [indexEnabled, serverId]);

  useEffect(() => {
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
    if (loading || !hasMore || genreFiltered) return;
    if (compFilterClientOnly && visibleAlbums.length === 0
      && albumBrowseCompScanComplete(albums, compFilter, hasMore)) {
      return;
    }
    const next = page + 1;
    setPage(next);
    loadBrowse(browseQuery, next * PAGE_SIZE, true);
  }, [
    loading,
    hasMore,
    page,
    browseQuery,
    loadBrowse,
    genreFiltered,
    compFilterClientOnly,
    visibleAlbums.length,
    albums,
    compFilter,
  ]);

  useEffect(() => {
    if (!pendingClientFilterMatch || loading) return;
    loadMore();
  }, [pendingClientFilterMatch, loading, loadMore]);

  return {
    albums,
    loading,
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
  };
}
