import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbumsByGenre } from '../api/subsonicGenres';
import { getAlbumList, getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { dedupeById } from '../utils/dedupeById';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { showToast } from '../utils/ui/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { CheckSquare2, Download, HardDriveDownload, Disc3, ListPlus } from 'lucide-react';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { ALBUMS_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import {
  runLocalAlbumBrowsePage,
  runLocalAlbumsByGenres,
  type AlbumBrowseSort,
} from '../utils/library/browseTextSearch';

type SortType = AlbumBrowseSort;
type CompFilter = 'all' | 'only' | 'hide';

const PAGE_SIZE = 30;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, 500, 0)));
  return dedupeById(results.flat());
}

export default function Albums() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const auth = useAuthStore();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
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

  // ── Data loading ─────────────────────────────────────────────────────────
  const genreFiltered = selectedGenres.length > 0;
  const fromNum = parseInt(yearFrom, 10);
  const toNum = parseInt(yearTo, 10);
  const yearActive = !isNaN(fromNum) && !isNaN(toNum) && fromNum >= 1 && toNum >= 1;

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    sort,
    genreFiltered,
    yearActive,
    yearFrom,
    yearTo,
    compFilter,
    starredOnly,
    selectionMode,
    selectedGenres,
  ]);

  const load = useCallback(async (
    sortType: SortType,
    offset: number,
    append = false,
    yearFilter?: { from: number; to: number },
  ) => {
    setLoading(true);
    try {
      let data: SubsonicAlbum[] | null = null;
      if (indexEnabled && serverId) {
        data = await runLocalAlbumBrowsePage(
          serverId,
          sortType,
          offset,
          PAGE_SIZE,
          yearFilter,
        );
      }
      if (data == null) {
        const extra = yearFilter ? { fromYear: yearFilter.from, toYear: yearFilter.to } : {};
        const type = yearFilter ? 'byYear' : sortType;
        data = await getAlbumList(type, PAGE_SIZE, offset, extra);
      }
      if (append) setAlbums(prev => [...prev, ...data]);
      else setAlbums(data);
      setHasMore(data.length === PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion, indexEnabled, serverId]);

  const loadFiltered = useCallback(async (genres: string[], sortType: SortType) => {
    setLoading(true);
    try {
      let data: SubsonicAlbum[] | null = null;
      if (indexEnabled && serverId) {
        data = await runLocalAlbumsByGenres(serverId, genres, sortType);
      }
      if (data == null) {
        data = await fetchByGenres(genres);
        data = [...data].sort((a, b) =>
          sortType === 'alphabeticalByArtist'
            ? a.artist.localeCompare(b.artist)
            : a.name.localeCompare(b.name),
        );
      }
      setAlbums(data);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion, indexEnabled, serverId]);

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
        ) : !loading && albums.length === 0 && !genreFiltered && !yearActive && !starredOnly && compFilter === 'all' ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : (
          <>
            {!perfFlags.disableMainstageGridCards && (
              <VirtualCardGrid
                items={visibleAlbums}
                itemKey={(a, _i) => a.id}
                rowVariant="album"
                disableVirtualization={perfFlags.disableMainstageVirtualLists}
                layoutSignal={visibleAlbums.length}
                scrollRootId={ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                renderItem={a => (
                  <AlbumCard
                    album={a}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(a.id)}
                    onToggleSelect={toggleSelect}
                    selectedAlbums={selectedAlbums}
                  />
                )}
              />
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
