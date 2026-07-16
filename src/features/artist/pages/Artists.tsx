import { useEffect, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, List, Images } from 'lucide-react';
import SelectionToggleButton from '@/ui/SelectionToggleButton';
import StarFilterButton from '@/ui/StarFilterButton';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID, ARTISTS_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useElementClientHeightById, useElementClientHeightForElement } from '@/lib/hooks/useResizeClientHeight';
import { useVirtualizerScrollMargin } from '@/lib/hooks/useVirtualizerScrollMargin';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import {
  ALL_SENTINEL,
  ALPHABET,
  OTHER_BUCKET,
  ARTIST_LIST_LAST_IN_LETTER_EST,
  ARTIST_LIST_LETTER_ROW_EST,
  ARTIST_LIST_ROW_EST,
} from '@/features/artist/utils/artistsHelpers';
import { useArtistsFiltering } from '@/features/artist/hooks/useArtistsFiltering';
import { useLibraryIgnoredArticles } from '@/lib/library/hooks/useLibraryIgnoredArticles';
import { useArtistsBrowseCatalog } from '@/features/artist/hooks/useArtistsBrowseCatalog';
import { useBrowseArtistTextSearch } from '@/features/artist/hooks/useBrowseArtistTextSearch';
import { useMainstageInpageHeaderTight } from '@/lib/hooks/useMainstageInpageHeaderTight';
import { useClientSliceInfiniteScroll } from '@/lib/hooks/useClientSliceInfiniteScroll';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';
import { useInpageScrollViewport } from '@/lib/hooks/useInpageScrollViewport';
import { ArtistsGridView } from '@/features/artist/components/ArtistsGridView';
import { ArtistsListView } from '@/features/artist/components/ArtistsListView';
import InpageScrollSentinel from '@/ui/InpageScrollSentinel';
import { useArtistsBrowseFilters, type ArtistBrowseScrollSnapshot } from '@/features/artist/hooks/useArtistsBrowseFilters';
import { useArtistsBrowseScrollRestore } from '@/features/artist/hooks/useArtistsBrowseScrollRestore';
import { useArtistsBrowseScrollReset } from '@/features/artist/hooks/useArtistsBrowseScrollReset';
import { useNavigateToArtist } from '@/features/artist/hooks/useNavigateToArtist';
import { peekArtistBrowseScrollRestore } from '@/features/artist/store/artistBrowseSessionStore';
import { nextArtistCreditMode } from '@/features/artist/utils/artistBrowseCreditMode';
import { readArtistBrowseRestore } from '@/lib/navigation/albumDetailNavigation';

import { useScopedBrowseSearchQuery } from '@/store/liveSearchScopeStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import {
  beginArtistsBrowseTrace,
  emitArtistsBrowseDebug,
} from '@/lib/library/artistBrowseDebug';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';
import { useBrowseLibraryScope } from '@/store/useBrowseLibraryScope';

export default function Artists() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const browseScope = useBrowseLibraryScope();
  const browseServerId = browseScope.anchorServerId || serverId;
  const sessionScopeKey = `${serverId}\0${browseScope.fingerprint}`;
  const libraryScopeKey = useAuthStore(s => {
    if (!serverId) return 'all';
    const resolved = resolveServerIdForIndexKey(serverId);
    const selection = s.musicLibrarySelectionByServer[resolved];
    if (selection !== undefined) {
      return selection.length === 0 ? 'all' : selection.join(',');
    }
    const legacy = s.musicLibraryFilterByServer[resolved];
    if (legacy === undefined || legacy === 'all') return 'all';
    return legacy;
  });
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));

  const scrollSnapshotRef = useRef<ArtistBrowseScrollSnapshot>({ scrollTop: 0, visibleCount: 0 });
  const restoreVisibleCountRef = useRef<number | undefined>(
    peekArtistBrowseScrollRestore(sessionScopeKey)?.visibleCount,
  );

  const {
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    creditMode,
    setCreditMode,
    viewMode,
    setViewMode,
  } = useArtistsBrowseFilters(sessionScopeKey, scrollSnapshotRef);

  useLayoutEffect(() => {
    beginArtistsBrowseTrace({
      serverId,
      indexEnabled,
      libraryFilterVersion: musicLibraryFilterVersion,
      libraryScopeCount: librarySelectionForServer(serverId).length,
      creditMode,
      letterFilter,
      viewMode,
    });
    return () => emitArtistsBrowseDebug('page_unmount');
  }, [serverId, indexEnabled, musicLibraryFilterVersion, creditMode, letterFilter, viewMode]);

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
  const ignoredArticles = useLibraryIgnoredArticles(serverId, indexEnabled);

  const {
    catalogArtists,
    loading: catalogLoading,
    catalogHasMore,
    catalogLoadingMore,
    browseMode,
    loadCatalogChunk,
    catalogLoadingRef,
  } = useArtistsBrowseCatalog({
    serverId: browseServerId,
    indexEnabled,
    starredOnly,
    creditMode,
    letterFilter,
    musicLibraryFilterVersion,
    libraryScopeKey,
    ignoredArticles,
    scopePairs: browseScope.pairs,
    scopeFingerprint: browseScope.fingerprint,
    localOnly: browseScope.multiServer,
  });

  const { textSearchArtists, textSearchLoading, effectiveFilter } = useBrowseArtistTextSearch(
    artistsSearchQuery,
    indexEnabled,
    browseServerId,
    'artists_browse',
    creditMode,
    starredOnly,
    browseScope.pairs,
    browseScope.multiServer,
  );
  const artists = starredOnly ? catalogArtists : (textSearchArtists ?? catalogArtists);
  const loading = starredOnly ? catalogLoading : (catalogLoading || textSearchLoading);
  const textSearchActive = !starredOnly && textSearchArtists != null;
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
    resetDeps: [artistsSearchQuery, letterFilter, starredOnly, creditMode, viewMode, musicLibraryFilterVersion, browseScope.fingerprint],
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

  const toggleSelect = useCallback((artist: Parameters<typeof libraryEntityKey>[0]) => {
    const id = libraryEntityKey(artist);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectedArtists = artists.filter(a => selectedIds.has(libraryEntityKey(a)));
  const openArtist = useCallback((artist: Parameters<typeof libraryEntityKey>[0]) => {
    const search = appendServerQuery(undefined, artist.serverId ?? undefined);
    navigateToArtist(artist.id, search ? { search } : undefined);
  }, [navigateToArtist]);

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

  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      emitArtistsBrowseDebug('ui_loading_false', {
        visibleCount: visible.length,
        artistCount: artists.length,
        viewMode,
        textSearchActive,
      });
    }
    prevLoadingRef.current = loading;
  }, [loading, visible.length, artists.length, viewMode, textSearchActive]);

  useLayoutEffect(() => {
    if (!loading && visible.length > 0) {
      emitArtistsBrowseDebug('browse_first_paint', {
        visibleCount: visible.length,
        viewMode,
        textSearchActive,
        letterFilter,
      });
    }
  }, [loading, visible.length, viewMode, textSearchActive, letterFilter]);

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

  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
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
    creditMode,
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
                  <StarFilterButton
                    size="compact"
                    active={starredOnly}
                    onChange={setStarredOnly}
                  />
                  <button
                    type="button"
                    className={`btn btn-surface${creditMode === 'track' ? ' btn-sort-active' : ''}`}
                    onClick={() => setCreditMode(nextArtistCreditMode(creditMode))}
                    data-tooltip={
                      creditMode === 'album'
                        ? t('artists.browse.creditMode.tooltipTrack')
                        : t('artists.browse.creditMode.tooltipAlbum')
                    }
                    data-tooltip-wrap
                    data-tooltip-pos="bottom"
                    aria-label={
                      creditMode === 'album'
                        ? t('artists.browse.creditMode.tooltipTrack')
                        : t('artists.browse.creditMode.tooltipAlbum')
                    }
                    style={
                      creditMode === 'track'
                        ? { background: 'var(--accent)', color: 'var(--text-on-accent)' }
                        : undefined
                    }
                  >
                    {creditMode === 'album'
                      ? t('artists.browse.creditMode.track')
                      : t('artists.browse.creditMode.album')}
                  </button>
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
              <SelectionToggleButton
                active={selectionMode}
                onToggle={toggleSelectionMode}
                selectLabel={t('artists.select')}
                cancelLabel={t('artists.cancelSelect')}
                startTooltip={t('artists.startSelect')}
                iconSize={20}
              />
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
            onOpenArtist={openArtist}
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
            onOpenArtist={openArtist}
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
