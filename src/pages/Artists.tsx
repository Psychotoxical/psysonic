import { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, List, Images, CheckSquare2 } from 'lucide-react';
import StarFilterButton from '../components/StarFilterButton';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID, ARTISTS_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById, useElementClientHeightForElement } from '../hooks/useResizeClientHeight';
import { useVirtualizerScrollMargin } from '../hooks/useVirtualizerScrollMargin';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import {
  ALL_SENTINEL,
  ALPHABET,
  OTHER_BUCKET,
  ARTIST_LIST_LAST_IN_LETTER_EST,
  ARTIST_LIST_LETTER_ROW_EST,
  ARTIST_LIST_ROW_EST,
} from '../utils/componentHelpers/artistsHelpers';
import { useArtistsFiltering } from '../hooks/useArtistsFiltering';
import { useLibraryIgnoredArticles } from '../hooks/useLibraryIgnoredArticles';
import { useArtistsBrowseCatalog } from '../hooks/useArtistsBrowseCatalog';
import { useBrowseArtistTextSearch } from '../hooks/useBrowseArtistTextSearch';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { useClientSliceInfiniteScroll } from '../hooks/useClientSliceInfiniteScroll';
import { useInpageScrollSentinel } from '../hooks/useInpageScrollSentinel';
import { useInpageScrollViewport } from '../hooks/useInpageScrollViewport';
import { ArtistsGridView } from '../components/artists/ArtistsGridView';
import { ArtistsListView } from '../components/artists/ArtistsListView';
import InpageScrollSentinel from '../components/InpageScrollSentinel';
import { useArtistsBrowseFilters, type ArtistBrowseScrollSnapshot } from '../hooks/useArtistsBrowseFilters';
import { useArtistsBrowseScrollRestore } from '../hooks/useArtistsBrowseScrollRestore';
import { useArtistsBrowseScrollReset } from '../hooks/useArtistsBrowseScrollReset';
import { useNavigateToArtist } from '../hooks/useNavigateToArtist';
import { peekArtistBrowseScrollRestore } from '../store/artistBrowseSessionStore';
import { readArtistBrowseRestore } from '../utils/navigation/albumDetailNavigation';

import { useScopedBrowseSearchQuery } from '../store/liveSearchScopeStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';

export default function Artists() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));

  const scrollSnapshotRef = useRef<ArtistBrowseScrollSnapshot>({ scrollTop: 0, visibleCount: 0 });
  const restoreVisibleCountRef = useRef<number | undefined>(
    peekArtistBrowseScrollRestore(serverId)?.visibleCount,
  );

  const {
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    viewMode,
    setViewMode,
  } = useArtistsBrowseFilters(serverId, scrollSnapshotRef);

  const artistsSearchQuery = useScopedBrowseSearchQuery('artists');

  const {
    scrollBodyEl: artistsScrollBodyEl,
    bindScrollBody: bindArtistsScrollBody,
    getScrollRoot: getArtistsScrollRoot,
  } = useInpageScrollViewport();

  const showArtistImages = useAuthStore(s => s.showArtistImages);
  const PAGE_SIZE = showArtistImages ? 50 : 100; // Smaller with images to reduce I/O
  const navigateToArtist = useNavigateToArtist();
  const location = useLocation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const setShowArtistImages = useAuthStore(s => s.setShowArtistImages);

  const {
    catalogArtists,
    loading: catalogLoading,
    catalogHasMore,
    catalogLoadingMore,
    browseMode,
    loadCatalogChunk,
    catalogLoadingRef,
  } = useArtistsBrowseCatalog({
    serverId,
    indexEnabled,
    starredOnly,
    musicLibraryFilterVersion,
  });

  const { textSearchArtists, textSearchLoading, effectiveFilter } = useBrowseArtistTextSearch(
    artistsSearchQuery,
    indexEnabled,
    serverId,
  );
  const artists = textSearchArtists ?? catalogArtists;
  const loading = catalogLoading || textSearchLoading;
  const textSearchActive = textSearchArtists != null;
  /** Scoped/plain text filter — canonical CSS grid, not row virtualization (small result sets). */
  const artistBrowsePlainLayout =
    perfFlags.disableMainstageVirtualLists
    || textSearchActive
    || artistsSearchQuery.trim().length > 0;

  const {
    visibleCount,
    loadingMore: sliceLoadingMore,
    loadMore: sliceLoadMore,
  } = useClientSliceInfiniteScroll({
    pageSize: PAGE_SIZE,
    resetDeps: [artistsSearchQuery, letterFilter, starredOnly, viewMode, musicLibraryFilterVersion, serverId],
    getScrollRoot: getArtistsScrollRoot,
    scrollRootEl: artistsScrollBodyEl,
    restoreDisplayCount: restoreVisibleCountRef.current,
  });

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectedArtists = artists.filter(a => selectedIds.has(a.id));

  const ignoredArticles = useLibraryIgnoredArticles(serverId, indexEnabled);

  const {
    filtered, visible, hasMore, groups, letters, artistListFlatRows,
  } = useArtistsFiltering({ artists, filter: effectiveFilter, letterFilter, starredOnly, visibleCount, viewMode, ignoredArticles });

  const pendingLetterMatch =
    browseMode === 'slice'
    && !textSearchActive
    && !starredOnly
    && letterFilter !== ALL_SENTINEL
    && filtered.length === 0
    && catalogHasMore;

  const gridHasMore =
    hasMore
    || (browseMode === 'slice' && !textSearchActive && !starredOnly && catalogHasMore);
  const gridLoadingMore = sliceLoadingMore || catalogLoadingMore;

  const loadMoreRef = useRef<() => void>(() => {});
  const sentinelIntersectingRef = useRef(false);

  const loadMoreGrid = useCallback(() => {
    if (hasMore) {
      sliceLoadMore();
      return;
    }
    if (browseMode === 'slice' && !textSearchActive && !starredOnly && catalogHasMore && !catalogLoadingRef.current) {
      void loadCatalogChunk(true);
    }
  }, [
    hasMore,
    sliceLoadMore,
    browseMode,
    textSearchActive,
    starredOnly,
    catalogHasMore,
    loadCatalogChunk,
    catalogLoadingRef,
  ]);

  loadMoreRef.current = loadMoreGrid;

  scrollSnapshotRef.current = {
    scrollTop: artistsScrollBodyEl?.scrollTop ?? 0,
    visibleCount,
  };

  const { isScrollRestorePending } = useArtistsBrowseScrollRestore({
    serverId,
    scrollBodyEl: artistsScrollBodyEl,
    visibleCount,
    loading: loading || pendingLetterMatch,
    loadingMore: gridLoadingMore,
    hasMore: gridHasMore,
    loadMore: loadMoreGrid,
  });

  useEffect(() => {
    if (isScrollRestorePending || !readArtistBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  useEffect(() => {
    if (!pendingLetterMatch || catalogLoadingRef.current) return;
    void loadCatalogChunk(true);
  }, [pendingLetterMatch, loadCatalogChunk, catalogLoadingRef]);

  useEffect(() => {
    if (browseMode !== 'slice' || textSearchActive || starredOnly) return;
    if (!sentinelIntersectingRef.current) return;
    if (visibleCount < filtered.length - PAGE_SIZE) return;
    if (!catalogHasMore || catalogLoadingRef.current) return;
    void loadCatalogChunk(true);
  }, [
    browseMode,
    textSearchActive,
    starredOnly,
    visibleCount,
    filtered.length,
    catalogHasMore,
    loadCatalogChunk,
    catalogLoadingRef,
    PAGE_SIZE,
  ]);

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: gridHasMore,
    getScrollRoot: getArtistsScrollRoot,
    scrollRootEl: artistsScrollBodyEl,
    onIntersect: () => loadMoreRef.current(),
    drainSignal: gridLoadingMore,
    intersectingRef: sentinelIntersectingRef,
  });

  const mainstageHeaderTight = useMainstageInpageHeaderTight(artistsScrollBodyEl, [
    artistsSearchQuery,
    letterFilter,
    starredOnly,
    viewMode,
  ]);

  const mainScrollViewportHeight = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);
  const artistsInpageScrollHeight = useElementClientHeightForElement(
    artistsScrollBodyEl,
    mainScrollViewportHeight,
  );

  const getInpageScrollElement = useCallback(
    () =>
      getArtistsScrollRoot()
      ?? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null),
    [getArtistsScrollRoot],
  );

  const artistListOverscan = Math.max(
    12,
    Math.ceil(artistsInpageScrollHeight / ARTIST_LIST_ROW_EST),
  );

  const artistListWrapRef = useRef<HTMLDivElement>(null);
  const artistListScrollMargin = useVirtualizerScrollMargin(
    artistListWrapRef,
    getInpageScrollElement,
    {
      active: !artistBrowsePlainLayout && viewMode === 'list',
      deps: [artistListFlatRows.length],
    },
  );

  const artistListVirtualizer = useVirtualizer({
    count:
      artistBrowsePlainLayout || viewMode !== 'list' ? 0 : artistListFlatRows.length,
    getScrollElement: getInpageScrollElement,
    estimateSize: index => {
      const row = artistListFlatRows[index];
      if (!row) return ARTIST_LIST_ROW_EST;
      if (row.kind === 'letter') return ARTIST_LIST_LETTER_ROW_EST;
      return row.isLastInLetter ? ARTIST_LIST_LAST_IN_LETTER_EST : ARTIST_LIST_ROW_EST;
    },
    getItemKey: index => {
      const row = artistListFlatRows[index];
      if (!row) return index;
      if (row.kind === 'letter') return `letter:${row.letter}`;
      return `artist:${row.artist.id}`;
    },
    overscan: artistListOverscan,
    scrollMargin: artistListScrollMargin,
  });

  const browseScrollResetKey = [
    artistsSearchQuery,
    letterFilter,
    starredOnly,
    viewMode,
    serverId,
    musicLibraryFilterVersion,
    textSearchArtists?.length ?? '',
    textSearchArtists?.[0]?.id ?? '',
  ].join('\0');

  useArtistsBrowseScrollReset({
    scrollSnapshotRef,
    getScrollRoot: getArtistsScrollRoot,
    isScrollRestorePending,
    resetKey: browseScrollResetKey,
    viewMode,
    listVirtualize: !artistBrowsePlainLayout,
    listVirtualizer: artistListVirtualizer,
  });

  return (
    <div
      className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}
    >
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header">
          <div className="mainstage-inpage-toolbar-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <h1 className="page-title" style={{ marginBottom: 0 }}>
                {selectionMode && selectedIds.size > 0
                  ? t('artists.selectionCount', { count: selectedIds.size })
                  : t('artists.title')}
              </h1>
              {textSearchLoading && (
                <div className="spinner" style={{ width: 16, height: 16, flexShrink: 0 }} />
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {!(selectionMode && selectedIds.size > 0) && (<>
                  <StarFilterButton size="compact" active={starredOnly} onChange={setStarredOnly} />
                  <button
                    className={`btn btn-surface`}
                    onClick={() => setShowArtistImages(!showArtistImages)}
                    style={showArtistImages ? { background: 'var(--accent)', color: 'var(--text-on-accent)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={showArtistImages ? t('artists.imagesOn') : t('artists.imagesOff')}
                    data-tooltip-wrap
                    data-tooltip-pos="bottom"
                  >
                    <Images size={20} />
                  </button>
                  <button
                    className={`btn btn-surface ${viewMode === 'grid' ? 'btn-sort-active' : ''}`}
                    onClick={() => setViewMode('grid')}
                    style={viewMode === 'grid' ? { background: 'var(--accent)', color: 'var(--text-on-accent)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={t('artists.gridView')}
                    data-tooltip-pos="bottom"
                  >
                    <LayoutGrid size={20} />
                  </button>
                  <button
                    className={`btn btn-surface ${viewMode === 'list' ? 'btn-sort-active' : ''}`}
                    onClick={() => setViewMode('list')}
                    style={viewMode === 'list' ? { background: 'var(--accent)', color: 'var(--text-on-accent)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={t('artists.listView')}
                    data-tooltip-pos="bottom"
                  >
                    <List size={20} />
                  </button>
                </>
              )}
              <button
                className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
                onClick={toggleSelectionMode}
                data-tooltip={selectionMode ? t('artists.cancelSelect') : t('artists.startSelect')}
                data-tooltip-pos="bottom"
                style={selectionMode ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}}
              >
                <CheckSquare2 size={15} />
                {selectionMode ? t('artists.cancelSelect') : t('artists.select')}
              </button>
            </div>
          </div>

          <div className="mainstage-inpage-toolbar-alpha-row">
            {ALPHABET.map(l => (
              <button
                key={l}
                onClick={() => setLetterFilter(l)}
                className={`artists-alpha-btn${letterFilter === l ? ' artists-alpha-btn--active' : ''}`}
              >
                {l === ALL_SENTINEL ? t('artists.all') : l === OTHER_BUCKET ? t('artists.other') : l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={ARTISTS_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindArtistsScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          viewMode,
          visible.length,
          artistListFlatRows.length,
          filtered.length,
          gridHasMore,
          selectionMode,
        ]}
      >
        <div style={{ position: 'relative' }}>
        <div style={{ visibility: isScrollRestorePending ? 'hidden' : 'visible' }}>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>}

        {!loading && pendingLetterMatch && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        )}

        {!loading && !pendingLetterMatch && viewMode === 'grid' && (
          <ArtistsGridView
            visible={visible}
            disableVirtualization={artistBrowsePlainLayout}
            layoutKey={browseScrollResetKey}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            selectedArtists={selectedArtists}
            showArtistImages={showArtistImages}
            toggleSelect={toggleSelect}
            onOpenArtist={navigateToArtist}
            openContextMenu={openContextMenu}
            t={t}
          />
        )}

        {!loading && !pendingLetterMatch && viewMode === 'list' && (
          <ArtistsListView
            virtualized={!artistBrowsePlainLayout}
            groups={groups}
            letters={letters}
            artistListFlatRows={artistListFlatRows}
            artistListVirtualizer={artistListVirtualizer}
            artistListWrapRef={artistListWrapRef}
            artistListScrollMargin={artistListScrollMargin}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            selectedArtists={selectedArtists}
            showArtistImages={showArtistImages}
            toggleSelect={toggleSelect}
            onOpenArtist={navigateToArtist}
            openContextMenu={openContextMenu}
            t={t}
          />
        )}

        {!loading && gridHasMore && (
          <InpageScrollSentinel bindSentinel={bindLoadMoreSentinel} loading={gridLoadingMore} />
        )}

        {!loading && !pendingLetterMatch && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
            {t('artists.notFound')}
          </div>
        )}
        </div>
        {isScrollRestorePending && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div className="spinner" />
          </div>
        )}
        </div>
      </OverlayScrollArea>
    </div>
  );
}
