import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbum } from '../api/subsonicLibrary';
import { songToTrack } from '../utils/playback/songToTrack';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import AlbumCard from '../components/AlbumCard';
import { albumGridWarmCovers, coverDisplayCssPxForAlbumGrid } from '../cover/layoutSizes';
import { coverPrefetchRegister } from '../cover/prefetchRegistry';
import { coverArtRef } from '../cover/ref';
import { useAuthStore } from '../store/authStore';
import { clampLibraryGridMaxColumns } from '../store/authStoreHelpers';
import { computeCardGridColumnCount } from '../utils/cardGridLayout';
import GenreFilterBar from '../components/GenreFilterBar';
import YearFilterButton from '../components/YearFilterButton';
import StarFilterButton from '../components/StarFilterButton';
import LosslessFilterButton from '../components/LosslessFilterButton';
import SortDropdown from '../components/SortDropdown';
import { useTranslation } from 'react-i18next';
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
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { ALBUMS_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { useAlbumBrowseFilters } from '../hooks/useAlbumBrowseFilters';
import { useAlbumBrowseData } from '../hooks/useAlbumBrowseData';
import { useAlbumCatalogYearBounds } from '../hooks/useAlbumCatalogYearBounds';
import type { AlbumBrowseSort } from '../utils/library/albumBrowseSort';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';

type SortType = AlbumBrowseSort;

function sanitizeFilename(name: string): string {
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
  } = useAlbumBrowseFilters(serverId);

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const {
    albums,
    loading,
    hasMore,
    visibleAlbums,
    genreFiltered,
    serverFilterActive,
    narrowGenreList,
    genreCatalogOptions,
    yearFilterActive,
    debouncedYearFields,
    compFilterActive,
    pendingClientFilterMatch,
    loadMore,
  } = useAlbumBrowseData({
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
  });

  const observerTarget = useRef<HTMLDivElement>(null);
  const gridMeasureRef = useRef<HTMLDivElement>(null);
  const maxGridCols = useAuthStore(s => clampLibraryGridMaxColumns(s.libraryGridMaxColumns));
  const [albumCellDisplayCssPx, setAlbumCellDisplayCssPx] = useState(140);
  const [albumGridCols, setAlbumGridCols] = useState(4);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollBodyEl, setScrollBodyEl] = useState<HTMLDivElement | null>(null);
  const bindAlbumsScrollBody = useCallback((el: HTMLDivElement | null) => {
    scrollBodyRef.current = el;
    setScrollBodyEl(el);
  }, []);

  // ── Multi-selection ──────────────────────────────────────────────────────
  // selectedIds + toggleSelect come from useRangeSelection (declared after
  // `visibleAlbums` so Shift-click range expansion follows the visible order).
  const [selectionMode, setSelectionMode] = useState(false);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(visibleAlbums);

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const selectedAlbums = visibleAlbums.filter(a => selectedIds.has(a.id));
  const enqueue = usePlayerStore(state => state.enqueue);

  const handleEnqueueSelected = async () => {
    if (selectedAlbums.length === 0) return;
    try {
      // Parallel — Navidrome handles concurrent getAlbum requests fine.
      const results = await Promise.all(selectedAlbums.map(a => getAlbum(a.id).catch(() => null)));
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
        const detail = await getAlbum(album.id);
        downloadAlbum(album.id, album.name, album.artist, album.coverArt, album.year, detail.songs, serverId);
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
  }, [maxGridCols, visibleAlbums.length]);

  useEffect(() => {
    const viewportBudget = Math.max(albumGridCols * 3, albumGridCols);
    const refs = visibleAlbums
      .slice(0, viewportBudget)
      .flatMap(a => (a.coverArt ? [coverArtRef(a.coverArt)] : []));
    return coverPrefetchRegister(refs, { surface: 'dense', priority: 'high' });
  }, [visibleAlbums, albumGridCols]);

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
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
  }, [indexEnabled, losslessOnly]);

  useEffect(() => {
    const node = observerTarget.current;
    if (!node) return;
    const root = scrollBodyRef.current;
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) loadMore(); },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: '1500px',
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, scrollBodyEl]);

  const sortOptions: { value: SortType; label: string }[] = [
    { value: 'alphabeticalByName',   label: t('albums.sortByName') },
    { value: 'alphabeticalByArtist', label: t('albums.sortByArtist') },
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
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleEnqueueSelected}>
                    <ListPlus size={15} />
                    {t('albums.enqueueSelected', { count: selectedIds.size })}
                  </button>
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleAddOffline}>
                    <HardDriveDownload size={15} />
                    {t('albums.addOffline')}
                  </button>
                  <button className="btn btn-surface albums-selection-action-btn" onClick={handleDownloadZips}>
                    <Download size={15} />
                    {t('albums.downloadZips')}
                  </button>
                </>
              ) : (
                <>
                  <SortDropdown
                    value={sort}
                    options={sortOptions}
                    onChange={onSortChange}
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
                    catalogGenres={narrowGenreList ? genreCatalogOptions : null}
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
                      ...(compFilter !== 'all' ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}),
                    }}
                  >
                    <Disc3 size={14} />
                    {compFilter === 'all' ? t('albums.compilationLabel')
                      : compFilter === 'only' ? t('albums.compilationOnly')
                      : t('albums.compilationHide')}
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
                style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
              >
                <CheckSquare2 size={15} />
                {selectionMode ? t('albums.cancelSelect') : t('albums.select')}
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
          visibleAlbums.length,
          genreFiltered,
          hasMore,
          selectionMode,
          sort,
          perfFlags.disableMainstageGridCards,
          perfFlags.disableMainstageVirtualLists,
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
        ) : (
          <>
            {!perfFlags.disableMainstageGridCards && (
              <div ref={gridMeasureRef}>
                <VirtualCardGrid
                  items={visibleAlbums}
                  itemKey={(a, _i) => a.id}
                  rowVariant="album"
                  disableVirtualization={perfFlags.disableMainstageVirtualLists}
                  layoutSignal={visibleAlbums.length}
                  scrollRootId={ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                  warmGridCovers={albumGridWarmCovers(
                    albumCellDisplayCssPx,
                    Math.min(visibleAlbums.length, Math.max(albumGridCols * 6, 48)),
                  )}
                  renderItem={a => (
                    <AlbumCard
                      album={a}
                      displayCssPx={albumCellDisplayCssPx}
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
            {!genreFiltered && (
              <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
                {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
              </div>
            )}
          </>
        )}
      </OverlayScrollArea>
    </div>
  );
}
