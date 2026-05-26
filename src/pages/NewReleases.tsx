import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbumsByGenre } from '../api/subsonicGenres';
import { getAlbumList, getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { dedupeById } from '../utils/dedupeById';
import { useEffect, useState, useCallback, useRef } from 'react';
import { CheckSquare2, Download, HardDriveDownload } from 'lucide-react';
import AlbumCard from '../components/AlbumCard';
import GenreFilterBar from '../components/GenreFilterBar';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/ui/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';

const PAGE_SIZE = 30;

function sanitizeFilename(name: string): string {
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
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const observerTarget = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollBodyEl, setScrollBodyEl] = useState<HTMLDivElement | null>(null);
  const bindNewReleasesScrollBody = useCallback((el: HTMLDivElement | null) => {
    scrollBodyRef.current = el;
    setScrollBodyEl(el);
  }, []);
  const [selectionMode, setSelectionMode] = useState(false);
  const filtered = selectedGenres.length > 0;

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    filtered,
    selectionMode,
    selectedGenres,
  ]);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(albums);

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };
  const selectedAlbums = albums.filter(a => selectedIds.has(a.id));

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

  const load = useCallback(async (offset: number, append = false) => {
    setLoading(true);
    try {
      const data = await getAlbumList('newest', PAGE_SIZE, offset);
      if (append) setAlbums(prev => [...prev, ...data]);
      else setAlbums(data);
      setHasMore(data.length === PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFiltered = useCallback(async (genres: string[]) => {
    setLoading(true);
    try {
      setAlbums(await fetchByGenres(genres));
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    if (filtered) loadFiltered(selectedGenres);
    else { setPage(0); load(0); }
  }, [filtered, selectedGenres, load, loadFiltered]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || filtered) return;
    const next = page + 1;
    setPage(next);
    load(next * PAGE_SIZE, true);
  }, [loading, hasMore, page, load, filtered]);

  useEffect(() => {
    const node = observerTarget.current;
    if (!node) return;
    const root = scrollBodyRef.current;
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) loadMore(); },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: '200px',
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, scrollBodyEl]);

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

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindNewReleasesScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          albums.length,
          filtered,
          hasMore,
          selectionMode,
          perfFlags.disableMainstageVirtualLists,
        ]}
      >
        {loading && albums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loading && albums.length === 0 && !filtered ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : (
          <>
            <VirtualCardGrid
              items={albums}
              itemKey={(a, _i) => a.id}
              rowVariant="album"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={albums.length}
              scrollRootId={NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID}
              warmGridCovers={albumGridWarmCovers()}
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
            {!filtered && (
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
