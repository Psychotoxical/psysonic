import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbumsByGenre } from '../api/subsonicGenres';
import { getAlbumList, getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import AlbumCard from '../components/AlbumCard';
import GenreFilterBar from '../components/GenreFilterBar';
import YearFilterButton from '../components/YearFilterButton';
import StarFilterButton from '../components/StarFilterButton';
import SortDropdown from '../components/SortDropdown';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlayerStore } from '../store/playerStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { CheckSquare2, Download, HardDriveDownload, ListMusic, Disc3, ListPlus } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById } from '../hooks/useResizeClientHeight';
import { usePerfProbeFlags } from '../utils/perfFlags';
import { useRangeSelection } from '../hooks/useRangeSelection';

const ALBUM_GRID_GAP_PX = 16; // matches --space-4
const ALBUM_GRID_MIN_CARD_PX = 140;
/** Estimated row height for virtual window (card + margin). */
const ALBUM_VIRTUAL_ROW_HEIGHT = 288;

type SortType = 'alphabeticalByName' | 'alphabeticalByArtist';
type CompFilter = 'all' | 'only' | 'hide';

const PAGE_SIZE = 30;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, 500, 0)));
  const seen = new Set<string>();
  return results.flat().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
}

export default function Albums() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const auth = useAuthStore();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [sort, setSort] = useState<SortType>('alphabeticalByName');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [compFilter, setCompFilter] = useState<CompFilter>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);

  // ── Multi-selection ──────────────────────────────────────────────────────
  // selectedIds + toggleSelect come from useRangeSelection (declared after
  // `visibleAlbums` so Shift-click range expansion follows the visible order).
  const [selectionMode, setSelectionMode] = useState(false);

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const visibleAlbums = useMemo(() => {
    let out = albums;
    if (compFilter === 'only') out = out.filter(a => a.isCompilation);
    else if (compFilter === 'hide') out = out.filter(a => !a.isCompilation);
    if (starredOnly) {
      out = out.filter(a => a.id in starredOverrides ? starredOverrides[a.id] : !!a.starred);
    }
    return out;
  }, [albums, compFilter, starredOnly, starredOverrides]);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(visibleAlbums);

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const albumGridWrapRef = useRef<HTMLDivElement>(null);
  const [albumGridCols, setAlbumGridCols] = useState(4);

  useLayoutEffect(() => {
    if (perfFlags.disableMainstageVirtualLists) return;
    const el = albumGridWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const cols = Math.max(1, Math.floor((w + ALBUM_GRID_GAP_PX) / (ALBUM_GRID_MIN_CARD_PX + ALBUM_GRID_GAP_PX)));
      setAlbumGridCols(cols);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [perfFlags.disableMainstageVirtualLists, visibleAlbums.length]);

  const albumVirtualRowCount = Math.max(0, Math.ceil(visibleAlbums.length / albumGridCols));

  const mainScrollViewportHeight = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);
  /** ~One full viewport of grid rows above + below visible range (TanStack overscan = rows per side). */
  const albumGridOverscan = Math.max(
    2,
    Math.ceil(mainScrollViewportHeight / ALBUM_VIRTUAL_ROW_HEIGHT),
  );

  const albumGridVirtualizer = useVirtualizer({
    count: perfFlags.disableMainstageVirtualLists ? 0 : albumVirtualRowCount,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: () => ALBUM_VIRTUAL_ROW_HEIGHT,
    overscan: albumGridOverscan,
  });

  const selectedAlbums = visibleAlbums.filter(a => selectedIds.has(a.id));
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
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

  // ── Data loading ─────────────────────────────────────────────────────────
  const genreFiltered = selectedGenres.length > 0;
  const fromNum = parseInt(yearFrom, 10);
  const toNum = parseInt(yearTo, 10);
  const yearActive = !isNaN(fromNum) && !isNaN(toNum) && fromNum >= 1 && toNum >= 1;

  const load = useCallback(async (
    sortType: SortType,
    offset: number,
    append = false,
    yearFilter?: { from: number; to: number },
  ) => {
    setLoading(true);
    try {
      const extra = yearFilter ? { fromYear: yearFilter.from, toYear: yearFilter.to } : {};
      const type = yearFilter ? 'byYear' : sortType;
      const data = await getAlbumList(type, PAGE_SIZE, offset, extra);
      if (append) setAlbums(prev => [...prev, ...data]);
      else setAlbums(data);
      setHasMore(data.length === PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion]);

  const loadFiltered = useCallback(async (genres: string[], sortType: SortType) => {
    setLoading(true);
    try {
      const data = await fetchByGenres(genres);
      const sorted = [...data].sort((a, b) =>
        sortType === 'alphabeticalByArtist'
          ? a.artist.localeCompare(b.artist)
          : a.name.localeCompare(b.name)
      );
      setAlbums(sorted);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    setPage(0);
    if (genreFiltered) {
      loadFiltered(selectedGenres, sort);
    } else if (yearActive) {
      load(sort, 0, false, { from: fromNum, to: toNum });
    } else {
      load(sort, 0);
    }
  }, [sort, genreFiltered, selectedGenres, yearActive, fromNum, toNum, load, loadFiltered]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || genreFiltered) return;
    const next = page + 1;
    setPage(next);
    const yf = yearActive ? { from: fromNum, to: toNum } : undefined;
    load(sort, next * PAGE_SIZE, true, yf);
  }, [loading, hasMore, page, sort, load, genreFiltered, yearActive, fromNum, toNum]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      // Prefetch ~1.5 screens ahead so the user never visibly waits at the
      // bottom of the grid. 200px caught the user at the very edge.
      { rootMargin: '1500px' }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [loadMore]);

  const sortOptions: { value: SortType; label: string }[] = [
    { value: 'alphabeticalByName',   label: t('albums.sortByName') },
    { value: 'alphabeticalByArtist', label: t('albums.sortByArtist') },
  ];

  return (
    <div className="content-body animate-fade-in">
      {!perfFlags.disableMainstageStickyHeader && (
        <div className="page-sticky-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
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
                {!yearActive && (
                  <SortDropdown
                    value={sort}
                    options={sortOptions}
                    onChange={setSort}
                  />
                )}

                <YearFilterButton
                  from={yearFrom}
                  to={yearTo}
                  onChange={(from, to) => { setYearFrom(from); setYearTo(to); }}
                />

                <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />

                <StarFilterButton active={starredOnly} onChange={setStarredOnly} />

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
      )}

      {loading && albums.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
          {!perfFlags.disableMainstageGridCards && (
            perfFlags.disableMainstageVirtualLists ? (
              <div className="album-grid-wrap">
                {visibleAlbums.map(a => (
                  <AlbumCard
                    key={a.id}
                    album={a}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(a.id)}
                    onToggleSelect={toggleSelect}
                    selectedAlbums={selectedAlbums}
                  />
                ))}
              </div>
            ) : (
              <div
                ref={albumGridWrapRef}
                className="album-grid-wrap"
                style={{ display: 'block', position: 'relative', width: '100%' }}
              >
                <div
                  style={{
                    height: albumVirtualRowCount === 0 ? 0 : albumGridVirtualizer.getTotalSize(),
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {albumGridVirtualizer.getVirtualItems().map(vRow => {
                    const start = vRow.index * albumGridCols;
                    const rowAlbums = visibleAlbums.slice(start, start + albumGridCols);
                    return (
                      <div
                        key={vRow.key}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${vRow.start}px)`,
                          display: 'grid',
                          gridTemplateColumns: `repeat(${albumGridCols}, minmax(0, 1fr))`,
                          gap: 'var(--space-4)',
                          alignItems: 'start',
                        }}
                      >
                        {rowAlbums.map(a => (
                          <AlbumCard
                            key={a.id}
                            album={a}
                            selectionMode={selectionMode}
                            selected={selectedIds.has(a.id)}
                            onToggleSelect={toggleSelect}
                            selectedAlbums={selectedAlbums}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )}
          {!genreFiltered && (
            <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
              {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
            </div>
          )}
        </>
      )}

    </div>
  );
}
