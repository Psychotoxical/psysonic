import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { resolveAlbum } from '../utils/offline/offlineMediaResolve';
import { songToTrack } from '../utils/playback/songToTrack';
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import AlbumCard from '../components/AlbumCard';
import { albumGridWarmCovers, coverDisplayCssPxForAlbumGrid } from '../cover/layoutSizes';
import { useLibraryCoverPrefetch } from '../cover/useLibraryCoverPrefetch';
import { useAuthStore } from '../store/authStore';
import { clampLibraryGridMaxColumns } from '../store/authStoreHelpers';
import { computeCardGridColumnCount } from '../utils/cardGridLayout';
import GenreFilterBar from '../components/GenreFilterBar';
import YearFilterButton from '../components/YearFilterButton';
import StarFilterButton from '../components/StarFilterButton';
import LosslessFilterButton from '../components/LosslessFilterButton';
import SortDropdown from '../components/SortDropdown';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlayerStore } from '../store/playerStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/ui/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { CheckSquare2, Download, HardDriveDownload, Disc3, ListPlus } from 'lucide-react';
import FilterQuickClear from '../components/FilterQuickClear';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { useInpageScrollViewport } from '../hooks/useInpageScrollViewport';
import InpageScrollSentinel from '../components/InpageScrollSentinel';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { ALBUMS_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { useAlbumBrowseFilters, useAlbumBrowseScrollSnapshotSync, type AlbumBrowseScrollSnapshot } from '../hooks/useAlbumBrowseFilters';
import { useAlbumBrowseData } from '../hooks/useAlbumBrowseData';
import { useAlbumBrowseScrollRestore } from '../hooks/useAlbumBrowseScrollRestore';
import { useAlbumBrowseScrollReset } from '../hooks/useAlbumBrowseScrollReset';
import { useBrowseAlbumTextSearch } from '../hooks/useBrowseAlbumTextSearch';
import { peekAlbumBrowseScrollRestore } from '../store/albumBrowseSessionStore';
import { readAlbumBrowseRestore } from '../utils/navigation/albumDetailNavigation';
import { albumArtistDisplayName } from '../utils/album/deriveAlbumHeaderArtistRefs';
import { useAlbumCatalogYearBounds } from '../hooks/useAlbumCatalogYearBounds';
import type { AlbumBrowseSort } from '../utils/library/albumBrowseSort';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';
import { resolveAlbumYearBounds } from '../utils/library/albumYearFilter';
import {
  filterAlbumsByCompilation,
  filterAlbumsByGenres,
  filterAlbumsByStarred,
  filterAlbumsByYearBounds,
} from '../utils/library/albumBrowseFilters';
import { useScopedBrowseSearchQuery } from '../store/liveSearchScopeStore';

type SortType = AlbumBrowseSort;

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for safe download filenames
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

export default function Albums() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const auth = useAuthStore();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const catalogYears = useAlbumCatalogYearBounds(serverId, indexEnabled, musicLibraryFilterVersion);
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);

  const scrollSnapshotRef = useRef<AlbumBrowseScrollSnapshot>({ scrollTop: 0, displayCount: 0 });
  const restoreDisplayCountRef = useRef<number | undefined>(
    peekAlbumBrowseScrollRestore(serverId, 'albums')?.displayCount,
  );

  const {
    sort,
    onSortChange,
    selectedGenres,
    setSelectedGenres,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    compFilter,
    setCompFilter,
    starredOnly,
    setStarredOnly,
    losslessOnly,
    setLosslessOnly,
  } = useAlbumBrowseFilters(serverId, scrollSnapshotRef);

  const albumsSearchQuery = useScopedBrowseSearchQuery('albums');
  const { textSearchAlbums, textSearchLoading } = useBrowseAlbumTextSearch(
    albumsSearchQuery,
    indexEnabled,
    serverId,
    losslessOnly,
  );

  const {
    scrollBodyEl,
    bindScrollBody: bindAlbumsScrollBody,
    getScrollRoot,
  } = useInpageScrollViewport();

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const browseData = useAlbumBrowseData({
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
    scrollRootEl: scrollBodyEl,
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    restoreDisplayCount: restoreDisplayCountRef.current,
  });

  const textSearchActive = textSearchAlbums != null;
  const albumBrowsePlainLayout =
    perfFlags.disableMainstageVirtualLists
    || textSearchActive
    || albumsSearchQuery.trim().length > 0;

  const textSearchYearBounds = useMemo(
    () => resolveAlbumYearBounds(browseData.debouncedYearFields.from, browseData.debouncedYearFields.to),
    [browseData.debouncedYearFields.from, browseData.debouncedYearFields.to],
  );

  const textSearchVisibleAlbums = useMemo(() => {
    if (!textSearchActive || !textSearchAlbums) return null;
    let out = textSearchAlbums;
    if (selectedGenres.length > 0) out = filterAlbumsByGenres(out, selectedGenres);
    if (textSearchYearBounds.active) out = filterAlbumsByYearBounds(out, textSearchYearBounds.bounds);
    if (compFilter !== 'all') out = filterAlbumsByCompilation(out, compFilter);
    if (starredOnly) out = filterAlbumsByStarred(out, starredOverrides);
    return out;
  }, [
    textSearchActive,
    textSearchAlbums,
    selectedGenres,
    textSearchYearBounds.active,
    textSearchYearBounds.bounds,
    compFilter,
    starredOnly,
    starredOverrides,
  ]);

  const albums = textSearchActive ? (textSearchAlbums ?? []) : browseData.albums;
  const loading = textSearchActive ? textSearchLoading : browseData.loading;
  const loadingMore = textSearchActive ? false : browseData.loadingMore;
  const hasMore = textSearchActive ? false : browseData.hasMore;
  const displayAlbums = useMemo(
    () => (textSearchActive ? (textSearchVisibleAlbums ?? []) : browseData.displayAlbums),
    [textSearchActive, textSearchVisibleAlbums, browseData.displayAlbums],
  );
  const visibleAlbums = textSearchActive ? (textSearchVisibleAlbums ?? []) : browseData.visibleAlbums;
  const genreFiltered = textSearchActive ? selectedGenres.length > 0 : browseData.genreFiltered;
  const serverFilterActive = textSearchActive
    ? selectedGenres.length > 0 || textSearchYearBounds.active || losslessOnly || starredOnly
    : browseData.serverFilterActive;
  const yearFilterActive = browseData.yearFilterActive;
  const debouncedYearFields = browseData.debouncedYearFields;
  const compFilterActive = browseData.compFilterActive;
  const pendingClientFilterMatch = textSearchActive ? false : browseData.pendingClientFilterMatch;
  const bindLoadMoreSentinel = browseData.bindLoadMoreSentinel;
  const loadMore = browseData.loadMore;

  useAlbumBrowseScrollSnapshotSync(scrollSnapshotRef, scrollBodyEl, displayAlbums.length);

  const { isScrollRestorePending } = useAlbumBrowseScrollRestore({
    serverId,
    surface: 'albums',
    scrollBodyEl,
    displayAlbumsLength: displayAlbums.length,
    loading,
    loadingMore,
    hasMore,
    loadMore,
  });

  useAlbumBrowseScrollReset({
    scrollSnapshotRef,
    getScrollRoot,
    isScrollRestorePending,
    resetKey: [
      albumsSearchQuery,
      sort,
      selectedGenres.join('\u0001'),
      yearFilterActive ? `${debouncedYearFields.from}:${debouncedYearFields.to}` : '',
      compFilter,
      starredOnly,
      losslessOnly,
      serverId,
    ].join('|'),
  });

  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (isScrollRestorePending || !readAlbumBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  const gridMeasureRef = useRef<HTMLDivElement>(null);
  const maxGridCols = useAuthStore(s => clampLibraryGridMaxColumns(s.libraryGridMaxColumns));
  const [albumCellDisplayCssPx, setAlbumCellDisplayCssPx] = useState(140);
  const [albumGridCols, setAlbumGridCols] = useState(4);

  // ── Multi-selection ──────────────────────────────────────────────────────
  // `displayAlbums` — visible grid slice (local index) or loaded SQL pages (network).
  const [selectionMode, setSelectionMode] = useState(false);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(displayAlbums);

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const selectedAlbums = displayAlbums.filter(a => selectedIds.has(a.id));
  const enqueue = usePlayerStore(state => state.enqueue);

  const handleEnqueueSelected = async () => {
    if (selectedAlbums.length === 0) return;
    try {
      // Parallel album resolves — Navidrome handles concurrent requests fine.
      const results = await Promise.all(
        selectedAlbums.map(a => resolveAlbum(serverId, a.id).catch(() => null)),
      );
      const tracks = results.flatMap(r => r ? r.songs.map(songToTrack) : []);
      if (tracks.length > 0) {
        enqueue(tracks);
        showToast(t('albums.enqueueQueued', { count: selectedAlbums.length }), 2500, 'info');
      }
    } finally {
      clearSelection();
    }
  };

  const cycleCompFilter = () => {
    setCompFilter(v => v === 'all' ? 'only' : v === 'only' ? 'hide' : 'all');
  };

  const handleDownloadZips = async () => {
    if (selectedAlbums.length === 0) return;
    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;
    const { start, complete, fail } = useZipDownloadStore.getState();
    clearSelection();
    for (const album of selectedAlbums) {
      const downloadId = crypto.randomUUID();
      const filename = `${sanitizeFilename(album.name)}.zip`;
      const destPath = await join(folder, filename);
      const url = buildDownloadUrl(album.id);
      start(downloadId, filename);
      try {
        await invoke('download_zip', { id: downloadId, url, destPath });
        complete(downloadId);
      } catch (e) {
        fail(downloadId);
        console.error('ZIP download failed for', album.name, e);
        showToast(t('albums.downloadZipFailed', { name: album.name }), 4000, 'error');
      }
    }
  };

  const handleAddOffline = async () => {
    if (selectedAlbums.length === 0) return;
    let queued = 0;
    for (const album of selectedAlbums) {
      try {
        const detail = await resolveAlbum(serverId, album.id);
        if (!detail) throw new Error('album unavailable');
        downloadAlbum(album.id, album.name, albumArtistDisplayName(album), album.coverArt, album.year, detail.songs, serverId);
        queued++;
      } catch {
        showToast(t('albums.offlineFailed', { name: album.name }), 3000, 'error');
      }
    }
    if (queued > 0) showToast(t('albums.offlineQueuing', { count: queued }), 3000, 'info');
    clearSelection();
  };

  const visibleEmptyMessage = useMemo(() => {
    if (starredOnly) return t('albums.noFavorites');
    if (compFilter === 'only') return t('albums.noCompilations');
    return t('albums.noMatchingFilters');
  }, [starredOnly, compFilter, t]);

  useLayoutEffect(() => {
    const el = gridMeasureRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const cols = computeCardGridColumnCount(w, maxGridCols);
      setAlbumGridCols(cols);
      setAlbumCellDisplayCssPx(coverDisplayCssPxForAlbumGrid(w, maxGridCols));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxGridCols, displayAlbums.length]);

  const prefetchLimit = Math.max(albumGridCols * 3, albumGridCols);
  const prefetchKey = useMemo(
    () => displayAlbums.slice(0, prefetchLimit).map(a => a.id).join('\u0001'),
    [displayAlbums, prefetchLimit],
  );
  const prefetchAlbums = useMemo(
    () => displayAlbums.slice(0, prefetchLimit),
    [displayAlbums, prefetchLimit],
  );

  useLibraryCoverPrefetch(
    [
      {
        albums: prefetchAlbums,
        priority: 'high',
      },
    ],
    [prefetchKey, albumGridCols],
  );

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    albumsSearchQuery,
    sort,
    genreFiltered,
    yearFilterActive,
    debouncedYearFields.from,
    debouncedYearFields.to,
    compFilter,
    starredOnly,
    losslessOnly,
    selectionMode,
    selectedGenres,
  ]);

  useEffect(() => {
    if (!indexEnabled && losslessOnly) setLosslessOnly(false);
  }, [indexEnabled, losslessOnly, setLosslessOnly]);

  const sortOptions: { value: SortType; label: string }[] = [
    { value: 'alphabeticalByName',   label: t('albums.sortByName') },
    { value: 'alphabeticalByArtist', label: t('albums.sortByArtist') },
    { value: 'byArtistThenYear',     label: t('albums.sortByArtistYear') },
  ];

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      {!perfFlags.disableMainstageStickyHeader && (
        <div className="mainstage-inpage-toolbar">
          <div className="page-sticky-header mainstage-inpage-toolbar-row">
            <h1 className="page-title" style={{ marginBottom: 0 }}>
              {selectionMode && selectedIds.size > 0
                ? t('albums.selectionCount', { count: selectedIds.size })
                : t('albums.title')}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {selectionMode && selectedIds.size > 0 ? (
                <>
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleEnqueueSelected} data-tooltip={t('albums.enqueueSelected', { count: selectedIds.size })} data-tooltip-pos="bottom">
                    <ListPlus size={15} />
                    <span className="toolbar-btn-label">{t('albums.enqueueSelected', { count: selectedIds.size })}</span>
                  </button>
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleAddOffline} data-tooltip={t('albums.addOffline')} data-tooltip-pos="bottom">
                    <HardDriveDownload size={15} />
                    <span className="toolbar-btn-label">{t('albums.addOffline')}</span>
                  </button>
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleDownloadZips} data-tooltip={t('albums.downloadZips')} data-tooltip-pos="bottom">
                    <Download size={15} />
                    <span className="toolbar-btn-label">{t('albums.downloadZips')}</span>
                  </button>
                </>
              ) : (
                <>
                  <SortDropdown
                    value={sort}
                    options={sortOptions}
                    onChange={onSortChange}
                    tooltip={t('albums.sortTooltip')}
                  />

                  <YearFilterButton
                    from={yearFrom}
                    to={yearTo}
                    catalogMinYear={catalogYears.min}
                    catalogMaxYear={catalogYears.max}
                    onChange={(from, to) => { setYearFrom(from); setYearTo(to); }}
                  />

                  <GenreFilterBar
                    selected={selectedGenres}
                    catalogGenres={browseData.genreCatalogActive ? browseData.genreCatalogOptions : null}
                    onSelectionChange={setSelectedGenres}
                  />

                  <StarFilterButton active={starredOnly} onChange={setStarredOnly} />

                  {indexEnabled && (
                    <LosslessFilterButton active={losslessOnly} onChange={setLosslessOnly} />
                  )}

                  <button
                    className={`btn btn-surface${compFilter !== 'all' ? ' btn-sort-active' : ''}`}
                    onClick={cycleCompFilter}
                    data-tooltip={
                      compFilter === 'all' ? t('albums.compilationTooltipAll')
                      : compFilter === 'only' ? t('albums.compilationTooltipOnly')
                      : t('albums.compilationTooltipHide')
                    }
                    data-tooltip-pos="bottom"
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      ...(compFilter !== 'all' ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}),
                    }}
                  >
                    <Disc3 size={14} />
                    <span className="toolbar-btn-label">
                      {compFilter === 'all' ? t('albums.compilationLabel')
                        : compFilter === 'only' ? t('albums.compilationOnly')
                        : t('albums.compilationHide')}
                    </span>
                    {compFilter !== 'all' && (
                      <FilterQuickClear onActiveChip onClear={() => setCompFilter('all')} />
                    )}
                  </button>
                </>
              )}

              <button
                className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
                onClick={toggleSelectionMode}
                data-tooltip={selectionMode ? t('albums.cancelSelect') : t('albums.startSelect')}
                data-tooltip-pos="bottom"
                style={selectionMode ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}}
              >
                <CheckSquare2 size={15} />
                <span className="toolbar-btn-label">{selectionMode ? t('albums.cancelSelect') : t('albums.select')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindAlbumsScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          displayAlbums.length,
          genreFiltered,
          hasMore,
          selectionMode,
          sort,
          albumsSearchQuery,
          perfFlags.disableMainstageGridCards,
          albumBrowsePlainLayout,
        ]}
      >
        {loading && albums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loading && albums.length === 0 && !serverFilterActive && !compFilterActive ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : !loading && albums.length === 0 && losslessOnly ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('losslessAlbums.empty')}
          </div>
        ) : !loading && visibleAlbums.length === 0 && pendingClientFilterMatch ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loading && visibleAlbums.length === 0 && (starredOnly || compFilterActive) ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {visibleEmptyMessage}
          </div>
        ) : !loading && textSearchActive && visibleAlbums.length === 0 ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('albums.noMatchingFilters')}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ visibility: isScrollRestorePending ? 'hidden' : 'visible' }}>
              {!perfFlags.disableMainstageGridCards && (
                <div ref={gridMeasureRef}>
                  <VirtualCardGrid
                    items={displayAlbums}
                    itemKey={(a, _i) => a.id}
                    rowVariant="album"
                    disableVirtualization={albumBrowsePlainLayout}
                    layoutSignal={displayAlbums.length}
                    scrollRootId={ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                    warmGridCovers={albumGridWarmCovers(
                      albumCellDisplayCssPx,
                      Math.min(displayAlbums.length, Math.max(albumGridCols * 6, 48)),
                    )}
                    renderItem={a => (
                      <AlbumCard
                        album={a}
                        displayCssPx={albumCellDisplayCssPx}
                        observeScrollRootId={ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                        linkQuery={losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(a.id)}
                        onToggleSelect={toggleSelect}
                        selectedAlbums={selectedAlbums}
                      />
                    )}
                  />
                </div>
              )}
              {hasMore && (
                <InpageScrollSentinel bindSentinel={bindLoadMoreSentinel} loading={loadingMore} />
              )}
            </div>
            {isScrollRestorePending && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  paddingTop: '3rem',
                  background: 'var(--bg-app)',
                }}
              >
                <div className="spinner" />
              </div>
            )}
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
