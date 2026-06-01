import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { dedupeById } from '../utils/dedupeById';
import type { AlbumBrowseSort } from '../utils/library/albumBrowseSort';
import {
  fetchGenreAlbumPage,
  GENRE_ALBUM_CATALOG_CHUNK,
} from '../utils/library/genreAlbumBrowse';
import { useClientSliceInfiniteScroll } from './useClientSliceInfiniteScroll';
import { useInpageScrollSentinel } from './useInpageScrollSentinel';

const CLIENT_SLICE_PAGE_SIZE = 60;

export function useGenreAlbumBrowse(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  sort: AlbumBrowseSort,
  musicLibraryFilterVersion: number,
  getScrollRoot?: () => HTMLElement | null,
  scrollRootEl?: HTMLElement | null,
  restoreDisplayCount?: number,
) {
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const catalogOffsetRef = useRef(0);
  const catalogLoadingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadingRef = useRef(false);
  const loadPendingRef = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});

  const {
    visibleCount,
    loadingMore: sliceLoadingMore,
    loadMore: sliceLoadMore,
  } = useClientSliceInfiniteScroll({
    pageSize: CLIENT_SLICE_PAGE_SIZE,
    resetDeps: [
      sort,
      genre,
      musicLibraryFilterVersion,
      serverId,
      indexEnabled,
    ],
    getScrollRoot,
    scrollRootEl,
    restoreDisplayCount,
  });

  const displayAlbums = useMemo(
    () => albums.slice(0, visibleCount),
    [albums, visibleCount],
  );

  const hasMore = visibleCount < albums.length || catalogHasMore;
  const loadingMore = sliceLoadingMore || catalogLoadingMore;

  const loadCatalogChunk = useCallback(async (offset: number, append: boolean) => {
    if (catalogLoadingRef.current || !genre) return;
    const generation = loadGenerationRef.current;
    catalogLoadingRef.current = true;
    setCatalogLoadingMore(true);
    try {
      const chunk = await fetchGenreAlbumPage(
        serverId,
        genre,
        indexEnabled,
        offset,
        GENRE_ALBUM_CATALOG_CHUNK,
        sort,
      );
      if (generation !== loadGenerationRef.current) return;
      if (append) {
        setAlbums(prev => {
          const merged = dedupeById([...prev, ...chunk.albums]);
          catalogOffsetRef.current = merged.length;
          return merged;
        });
      } else {
        setAlbums(chunk.albums);
        catalogOffsetRef.current = chunk.albums.length;
      }
      setCatalogHasMore(chunk.hasMore);
    } finally {
      catalogLoadingRef.current = false;
      if (generation === loadGenerationRef.current) {
        setCatalogLoadingMore(false);
      }
    }
  }, [serverId, genre, indexEnabled, sort]);

  useEffect(() => {
    if (!genre) {
      setAlbums([]);
      setCatalogHasMore(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    loadGenerationRef.current += 1;
    const generation = loadGenerationRef.current;
    catalogOffsetRef.current = 0;
    catalogLoadingRef.current = false;
    loadingRef.current = true;
    loadPendingRef.current = true;
    setLoading(true);
    setCatalogLoadingMore(false);
    setCatalogHasMore(false);
    setAlbums([]);

    void loadCatalogChunk(0, false).finally(() => {
      if (cancelled || generation !== loadGenerationRef.current) return;
      loadingRef.current = false;
      loadPendingRef.current = false;
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [serverId, genre, indexEnabled, sort, musicLibraryFilterVersion, loadCatalogChunk]);

  const loadMore = useCallback(() => {
    if (!genre || loadingRef.current || loadPendingRef.current) return;
    if (visibleCount < albums.length) {
      sliceLoadMore();
      return;
    }
    if (catalogHasMore && !catalogLoadingRef.current) {
      void loadCatalogChunk(catalogOffsetRef.current, true);
    }
  }, [genre, visibleCount, albums.length, catalogHasMore, sliceLoadMore, loadCatalogChunk]);

  loadMoreRef.current = loadMore;

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: hasMore,
    getScrollRoot,
    scrollRootEl,
    onIntersect: () => loadMoreRef.current(),
    drainSignal: loadingMore,
  });

  return {
    albums,
    displayAlbums,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    bindLoadMoreSentinel,
  };
}
