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
import { useCardGridMetrics } from '../hooks/useCardGridMetrics';
import { useRemeasureGridVirtualizer } from '../hooks/useRemeasureGridVirtualizer';
import { useVirtualizerScrollMargin } from '../hooks/useVirtualizerScrollMargin';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import {
  ALL_SENTINEL,
  ALPHABET,
  ARTIST_LIST_LAST_IN_LETTER_EST,
  ARTIST_LIST_LETTER_ROW_EST,
  ARTIST_LIST_ROW_EST,
} from '../utils/componentHelpers/artistsHelpers';
import { useArtistsFiltering } from '../hooks/useArtistsFiltering';
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
import { useNavigateToArtist } from '../hooks/useNavigateToArtist';
import { peekArtistBrowseScrollRestore } from '../store/artistBrowseSessionStore';
import { readArtistBrowseRestore } from '../utils/navigation/albumDetailNavigation';

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
    filter,
    setFilter,
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    viewMode,
    setViewMode,
  } = useArtistsBrowseFilters(serverId, scrollSnapshotRef);

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
    filter,
    indexEnabled,
    serverId,
  );
  const artists = textSearchArtists ?? catalogArtists;
  const loading = catalogLoading || textSearchLoading;
  const textSearchActive = textSearchArtists != null;

  const {
    visibleCount,
    loadingMore: sliceLoadingMore,
    loadMore: sliceLoadMore,
  } = useClientSliceInfiniteScroll({
    pageSize: PAGE_SIZE,
    resetDeps: [filter, letterFilter, starredOnly, viewMode, musicLibraryFilterVersion, serverId],
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

  const {
    filtered, visible, hasMore, groups, letters, artistListFlatRows,
  } = useArtistsFiltering({ artists, filter: effectiveFilter, letterFilter, starredOnly, visibleCount, viewMode });

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
    filter,
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

  const artistGridMeasureRef = useRef<HTMLDivElement>(null);
  const { gridCols: artistGridCols, rowHeightEst: artistGridRowHeightEst } = useCardGridMetrics(
    artistGridMeasureRef,
    viewMode === 'grid',
    'artist',
    visible.length,
  );

  const artistVirtualRowCount = Math.max(0, Math.ceil(visible.length / Math.max(1, artistGridCols)));

  const artistGridOverscan = Math.max(
    2,
    Math.ceil(artistsInpageScrollHeight / Math.max(1, artistGridRowHeightEst)),
  );

  const artistGridScrollMargin = useVirtualizerScrollMargin(
    artistGridMeasureRef,
    getInpageScrollElement,
    {
      active: !perfFlags.disableMainstageVirtualLists && viewMode === 'grid',
      deps: [artistVirtualRowCount, artistGridCols],
    },
  );

  const artistGridVirtualizer = useVirtualizer({
    count:
      perfFlags.disableMainstageVirtualLists || viewMode !== 'grid'
        ? 0
        : artistVirtualRowCount,
    getScrollElement: getInpageScrollElement,
    estimateSize: () => artistGridRowHeightEst,
    overscan: artistGridOverscan,
    scrollMargin: artistGridScrollMargin,
  });

  useRemeasureGridVirtualizer(artistGridVirtualizer, {
    active: !perfFlags.disableMainstageVirtualLists && viewMode === 'grid' && artistVirtualRowCount > 0,
    gridCols: artistGridCols,
    rowHeightEst: artistGridRowHeightEst,
    virtualRowCount: artistVirtualRowCount,
  });

  const artistListOverscan = Math.max(
    12,
    Math.ceil(artistsInpageScrollHeight / ARTIST_LIST_ROW_EST),
  );

  const artistListWrapRef = useRef<HTMLDivElement>(null);
  const artistListScrollMargin = useVirtualizerScrollMargin(
    artistListWrapRef,
    getInpageScrollElement,
    {
      active: !perfFlags.disableMainstageVirtualLists && viewMode === 'list',
      deps: [artistListFlatRows.length],
    },
  );

  const artistListVirtualizer = useVirtualizer({
    count:
      perfFlags.disableMainstageVirtualLists || viewMode !== 'list' ? 0 : artistListFlatRows.length,
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
              <input
                className="input"
                style={{ maxWidth: 220 }}
                placeholder={t('artists.search')}
                value={filter}
                onChange={e => setFilter(e.target.value)}
                id="artist-filter-input"
              />
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
                    style={showArtistImages ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={showArtistImages ? t('artists.imagesOn') : t('artists.imagesOff')}
                    data-tooltip-wrap
                  >
                    <Images size={20} />
                  </button>
                  <button
                    className={`btn btn-surface ${viewMode === 'grid' ? 'btn-sort-active' : ''}`}
                    onClick={() => setViewMode('grid')}
                    style={viewMode === 'grid' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={t('artists.gridView')}
                  >
                    <LayoutGrid size={20} />
                  </button>
                  <button
                    className={`btn btn-surface ${viewMode === 'list' ? 'btn-sort-active' : ''}`}
                    onClick={() => setViewMode('list')}
                    style={viewMode === 'list' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                    data-tooltip={t('artists.listView')}
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
                style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
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
                {l === ALL_SENTINEL ? t('artists.all') : l}
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
            gridCols={artistGridCols}
            measureRef={artistGridMeasureRef}
            virtualization={
              perfFlags.disableMainstageVirtualLists
                ? null
                : { virtualizer: artistGridVirtualizer, scrollMargin: artistGridScrollMargin }
            }
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
            virtualized={!perfFlags.disableMainstageVirtualLists}
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
