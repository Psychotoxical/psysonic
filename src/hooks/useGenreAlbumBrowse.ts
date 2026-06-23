import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { dedupeById } from '../utils/dedupeById';
import type { AlbumBrowseSort } from '../utils/library/albumBrowseSort';
import {
  fetchGenreAlbumPage,
  GENRE_ALBUM_CATALOG_CHUNK,
  GENRE_ALBUM_FIRST_PAGE,
} from '../utils/library/genreAlbumBrowse';
import { useClientSliceInfiniteScroll } from './useClientSliceInfiniteScroll';
import { useInpageScrollSentinel } from './useInpageScrollSentinel';

const CLIENT_SLICE_PAGE_SIZE = GENRE_ALBUM_FIRST_PAGE;

function initialSqlPageSize(restoreDisplayCount?: number): number {
  if (restoreDisplayCount != null && restoreDisplayCount > CLIENT_SLICE_PAGE_SIZE) {
    return Math.min(restoreDisplayCount, GENRE_ALBUM_CATALOG_CHUNK);
  }
  return CLIENT_SLICE_PAGE_SIZE;
}

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
  const browseSessionRef = useRef({ key: '', restoreDisplayCount: undefined as number | undefined });
  const browseKey = `${serverId}:${genre}`;
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  if (browseSessionRef.current.key !== browseKey) {
    // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
    // eslint-disable-next-line react-hooks/refs
    browseSessionRef.current = {
      key: browseKey,
      restoreDisplayCount: restoreDisplayCount,
    };
  }
  const sessionRestoreDisplayCount = browseSessionRef.current.restoreDisplayCount;

  const {
    visibleCount,
    loadingMore: sliceLoadingMore,
    loadMore: sliceLoadMore,
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
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
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    restoreDisplayCount: sessionRestoreDisplayCount,
  });

  const displayAlbums = useMemo(
    () => albums.slice(0, visibleCount),
    [albums, visibleCount],
  );

  const hasMore = visibleCount < albums.length || catalogHasMore;
  const loadingMore = sliceLoadingMore || catalogLoadingMore;

  const loadCatalogChunk = useCallback(async (
    offset: number,
    append: boolean,
    pageSize: number = GENRE_ALBUM_CATALOG_CHUNK,
  ) => {
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
        pageSize,
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
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const firstPageSize = initialSqlPageSize(sessionRestoreDisplayCount);
    void loadCatalogChunk(0, false, firstPageSize).finally(() => {
      if (cancelled || generation !== loadGenerationRef.current) return;
      loadingRef.current = false;
      loadPendingRef.current = false;
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // sessionRestoreDisplayCount is read once to restore the prior visible count;
    // the catalog load must not re-run when it later changes, so it is excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
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
