import { buildDownloadUrl } from '@/lib/api/subsonicStreamUrl';
import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { getAlbumList } from '@/lib/api/subsonicLibrary';
import { resolveAlbum } from '@/features/offline';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { dedupeById } from '@/lib/util/dedupeById';
import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Download, HardDriveDownload } from 'lucide-react';
import SelectionToggleButton from '@/ui/SelectionToggleButton';
import AlbumCard from '@/features/album/components/AlbumCard';
import GenreFilterBar from '@/ui/GenreFilterBar';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline';
import { useDownloadModalStore } from '@/features/offline';
import { downloadZip } from '@/lib/api/downloadZip';
import { join } from '@tauri-apps/api/path';
import { showToast } from '@/lib/dom/toast';
import { useZipDownloadStore } from '@/features/offline';
import { useRangeSelection } from '@/lib/hooks/useRangeSelection';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { useMainstageInpageHeaderTight } from '@/lib/hooks/useMainstageInpageHeaderTight';
import { albumGridWarmCovers } from '@/cover/layoutSizes';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useAsyncInpagePagination } from '@/lib/hooks/useAsyncInpagePagination';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';
import { useInpageScrollViewport } from '@/lib/hooks/useInpageScrollViewport';
import InpageScrollSentinel from '@/ui/InpageScrollSentinel';
import { useAlbumGridBrowseFilters, type AlbumGridBrowseSnapshot } from '@/features/album/hooks/useAlbumGridBrowseFilters';
import { useAlbumBrowseScrollRestore } from '@/features/album/hooks/useAlbumBrowseScrollRestore';
import { useAlbumBrowseScrollReset } from '@/features/album/hooks/useAlbumBrowseScrollReset';
import { useBrowseAlbumTextSearch } from '@/features/album/hooks/useBrowseAlbumTextSearch';
import { useAlbumBrowseScrollSnapshotSync, type AlbumBrowseScrollSnapshot } from '@/features/album/hooks/useAlbumBrowseFilters';
import { readAlbumBrowseRestore } from '@/lib/navigation/albumDetailNavigation';
import { albumArtistDisplayName } from '@/features/album/utils/deriveAlbumHeaderArtistRefs';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { filterAlbumsByGenres } from '@/lib/library/albumBrowseFilters';
import { useScopedBrowseSearchQuery } from '@/store/liveSearchScopeStore';

const PAGE_SIZE = 30;

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for safe download filenames
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, 500, 0)));
  return dedupeById(results.flat()).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

export default function NewReleases() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const auth = useAuthStore();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const navigate = useNavigate();
  const location = useLocation();

  const scrollSnapshotRef = useRef<AlbumBrowseScrollSnapshot>({ scrollTop: 0, displayCount: 0 });
  const gridSnapshotRef = useRef<AlbumGridBrowseSnapshot>({ albums: [], hasMore: true });
  const {
    selectedGenres,
    setSelectedGenres,
    initialAlbums,
    initialHasMore,
  } = useAlbumGridBrowseFilters(serverId, 'new-releases', scrollSnapshotRef, gridSnapshotRef);
  const restoringSessionRef = useRef(initialAlbums != null);

  const newReleasesSearchQuery = useScopedBrowseSearchQuery('newReleases');
  const { textSearchAlbums, textSearchLoading } = useBrowseAlbumTextSearch(
    newReleasesSearchQuery,
    indexEnabled,
    serverId,
  );
  const textSearchActive = textSearchAlbums != null;
  const scopedSearchQuery = newReleasesSearchQuery.trim();
  const albumBrowsePlainLayout =
    perfFlags.disableMainstageVirtualLists
    || textSearchActive
    || scopedSearchQuery.length > 0;

  const [albums, setAlbums] = useState<SubsonicAlbum[]>(() => initialAlbums ?? []);
  const [hasMore, setHasMore] = useState(() => initialHasMore ?? true);
  const {
    scrollBodyEl,
    bindScrollBody: bindNewReleasesScrollBody,
    getScrollRoot,
  } = useInpageScrollViewport();
  const {
    loading,
    setLoading,
    resetPage,
    runLoad,
    requestNextPage,
    isBlocked,
  } = useAsyncInpagePagination(PAGE_SIZE, { initialLoading: initialAlbums == null });
  const [selectionMode, setSelectionMode] = useState(false);
  const genreFiltered = selectedGenres.length > 0;

  const displayAlbums = useMemo(() => {
    if (textSearchActive && textSearchAlbums) {
      return genreFiltered
        ? filterAlbumsByGenres(textSearchAlbums, selectedGenres)
        : textSearchAlbums;
    }
    return albums;
  }, [textSearchActive, textSearchAlbums, albums, genreFiltered, selectedGenres]);

  const loadingGrid = textSearchActive ? textSearchLoading : loading;
  const gridHasMore = textSearchActive ? false : (!genreFiltered && hasMore);

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  gridSnapshotRef.current = { albums: displayAlbums, hasMore: gridHasMore };
  useAlbumBrowseScrollSnapshotSync(scrollSnapshotRef, scrollBodyEl, displayAlbums.length);

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    newReleasesSearchQuery,
    genreFiltered,
    selectionMode,
    selectedGenres,
  ]);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(displayAlbums);

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };
  const selectedAlbums = displayAlbums.filter(a => selectedIds.has(a.id));

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
        await downloadZip({ id: downloadId, url, destPath });
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

  const load = useCallback(async (offset: number, append = false) => {
    await runLoad(async () => {
      const data = await getAlbumList('newest', PAGE_SIZE, offset);
      if (append) setAlbums(prev => [...prev, ...data]);
      else setAlbums(data);
      setHasMore(data.length === PAGE_SIZE);
    });
  }, [runLoad]);

  const loadFiltered = useCallback(async (genres: string[]) => {
    setLoading(true);
    try {
      setAlbums(await fetchByGenres(genres));
      setHasMore(false);
    } finally {
      setLoading(false);
    }
    // musicLibraryFilterVersion is an intentional re-create trigger (fetchByGenres
    // reads the active library filter internally); the setters are stable. The
    // loader must refresh when that version bumps even though it is unused here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    if (restoringSessionRef.current || scopedSearchQuery) return;
    if (genreFiltered) loadFiltered(selectedGenres);
    else {
      resetPage();
      void load(0);
    }
  }, [genreFiltered, selectedGenres, load, loadFiltered, resetPage, scopedSearchQuery]);

  const loadMore = useCallback(() => {
    if (!gridHasMore || genreFiltered || textSearchActive || isBlocked()) return;
    requestNextPage(offset => load(offset, true));
  }, [gridHasMore, genreFiltered, textSearchActive, isBlocked, requestNextPage, load]);

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: gridHasMore,
    getScrollRoot,
    scrollRootEl: scrollBodyEl,
    onIntersect: loadMore,
  });

  const { isScrollRestorePending } = useAlbumBrowseScrollRestore({
    serverId,
    surface: 'new-releases',
    scrollBodyEl,
    displayAlbumsLength: displayAlbums.length,
    loading: loadingGrid,
    loadingMore: loadingGrid,
    hasMore: gridHasMore,
    loadMore,
  });

  useAlbumBrowseScrollReset({
    scrollSnapshotRef,
    getScrollRoot,
    isScrollRestorePending,
    resetKey: [newReleasesSearchQuery, selectedGenres.join('\u0001'), serverId].join('|'),
  });

  useLayoutEffect(() => {
    if (!isScrollRestorePending && restoringSessionRef.current) {
      restoringSessionRef.current = false;
    }
  }, [isScrollRestorePending]);

  useEffect(() => {
    if (isScrollRestorePending || !readAlbumBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header mainstage-inpage-toolbar-row">
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {selectionMode && selectedIds.size > 0
              ? t('albums.selectionCount', { count: selectedIds.size })
              : t('sidebar.newReleases')}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {selectionMode && selectedIds.size > 0 ? (
              <>
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
              <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />
            )}
            <SelectionToggleButton
              active={selectionMode}
              onToggle={toggleSelectionMode}
              selectLabel={t('albums.select')}
              cancelLabel={t('albums.cancelSelect')}
              startTooltip={t('albums.startSelect')}
            />
          </div>
        </div>
      </div>

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindNewReleasesScrollBody}
        railInset="panel"
        measureDeps={[
          loadingGrid,
          displayAlbums.length,
          genreFiltered,
          gridHasMore,
          selectionMode,
          newReleasesSearchQuery,
          albumBrowsePlainLayout,
        ]}
      >
        {loadingGrid && displayAlbums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loadingGrid && displayAlbums.length === 0 && !genreFiltered && !scopedSearchQuery ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : !loadingGrid && textSearchActive && displayAlbums.length === 0 ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('albums.noMatchingFilters')}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ visibility: isScrollRestorePending ? 'hidden' : 'visible' }}>
            <VirtualCardGrid
              items={displayAlbums}
              itemKey={(a, _i) => a.id}
              rowVariant="album"
              disableVirtualization={albumBrowsePlainLayout}
              layoutSignal={displayAlbums.length}
              scrollRootId={NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID}
              warmGridCovers={albumGridWarmCovers()}
              renderItem={a => (
                <AlbumCard
                  album={a}
                  observeScrollRootId={NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(a.id)}
                  onToggleSelect={toggleSelect}
                  selectedAlbums={selectedAlbums}
                />
              )}
            />
            {gridHasMore && (
              <InpageScrollSentinel bindSentinel={bindLoadMoreSentinel} loading={loadingGrid} />
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
