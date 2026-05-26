import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { useCallback, useEffect, useRef, useState } from 'react';
import AlbumCard from '../components/AlbumCard';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';
import { ndListLosslessAlbumsPage } from '../api/navidromeBrowse';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlayerStore } from '../store/playerStore';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { showToast } from '../utils/ui/toast';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { CheckSquare2, Download, HardDriveDownload, ListPlus } from 'lucide-react';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { runLocalLosslessAlbums } from '../utils/library/browseTextSearch';

/** Local index page size — SQLite is cheap; larger pages than the network walk. */
const LOCAL_PAGE_SIZE = 30;

/** Per-loadMore budget for the Navidrome bit_depth song-stream fallback. */
const NETWORK_TARGET_ALBUMS = 12;
const NETWORK_SONGS_PER_FETCH = 100;
const NETWORK_MAX_FETCHES_PER_LOAD = 2;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

export default function LosslessAlbums() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const auth = useAuthStore();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const enqueue = usePlayerStore(s => s.enqueue);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  /** `true` = local SQLite; `false` = Navidrome song-stream walk; `null` until first fetch picks. */
  const [useLocalIndex, setUseLocalIndex] = useState<boolean | null>(null);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(albums);
  const selectedAlbums = albums.filter(a => selectedIds.has(a.id));

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };

  /** Network pagination cursor — unused on the local path. */
  const songCursor = useRef(0);
  const seenIds = useRef<Set<string>>(new Set());
  const localOffset = useRef(0);
  const inFlight = useRef(false);
  const observerTarget = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollBodyEl, setScrollBodyEl] = useState<HTMLDivElement | null>(null);
  const bindLosslessScrollBody = useCallback((el: HTMLDivElement | null) => {
    scrollBodyRef.current = el;
    setScrollBodyEl(el);
  }, []);

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    unsupported,
    selectionMode,
    activeServerId,
  ]);

  const loadMoreNetwork = useCallback(async (onProgress?: (albums: SubsonicAlbum[]) => void) => {
    const page = await ndListLosslessAlbumsPage({
      startSongOffset: songCursor.current,
      seenAlbumIds: seenIds.current,
      targetNewAlbums: NETWORK_TARGET_ALBUMS,
      songsPerPage: NETWORK_SONGS_PER_FETCH,
      maxPagesPerCall: NETWORK_MAX_FETCHES_PER_LOAD,
      onProgress: onProgress
        ? (entries) => { onProgress(entries.map(e => e.album)); }
        : undefined,
    });
    songCursor.current = page.nextSongOffset;
    return page;
  }, []);

  const loadMoreLocal = useCallback(async () => {
    const page = await runLocalLosslessAlbums(serverId, LOCAL_PAGE_SIZE, localOffset.current);
    if (!page) return null;
    localOffset.current += page.albums.length;
    return page;
  }, [serverId]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || useLocalIndex === null) return;
    inFlight.current = true;
    setLoading(true);
    try {
      if (useLocalIndex) {
        const page = await loadMoreLocal();
        if (!page) {
          setHasMore(false);
          return;
        }
        setAlbums(prev => [...prev, ...page.albums]);
        setHasMore(page.hasMore);
      } else {
        const page = await loadMoreNetwork(albums => {
          setAlbums(prev => [...prev, ...albums]);
        });
        setHasMore(!page.done);
      }
    } catch {
      if (!useLocalIndex) {
        setUnsupported(true);
      }
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [loadMoreLocal, loadMoreNetwork, useLocalIndex]);

  useEffect(() => {
    let cancelled = false;

    songCursor.current = 0;
    seenIds.current = new Set();
    localOffset.current = 0;
    inFlight.current = false;
    setAlbums([]);
    setHasMore(true);
    setUnsupported(false);
    setUseLocalIndex(null);
    setLoading(true);

    (async () => {
      inFlight.current = true;
      try {
        if (indexEnabled && serverId) {
          const local = await runLocalLosslessAlbums(serverId, LOCAL_PAGE_SIZE, 0);
          if (cancelled) return;
          if (local) {
            setUseLocalIndex(true);
            localOffset.current = local.albums.length;
            setAlbums(local.albums);
            setHasMore(local.hasMore);
            return;
          }
        }

        if (cancelled) return;
        setUseLocalIndex(false);
        const page = await loadMoreNetwork(albums => {
          if (!cancelled) setAlbums(prev => [...prev, ...albums]);
        });
        if (cancelled) return;
        songCursor.current = page.nextSongOffset;
        setHasMore(!page.done);
      } catch {
        if (cancelled) return;
        setUseLocalIndex(false);
        setUnsupported(true);
        setHasMore(false);
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeServerId, indexEnabled, loadMoreNetwork, serverId]);

  useEffect(() => {
    if (!hasMore || useLocalIndex === null) return;
    const node = observerTarget.current;
    if (!node) return;
    const root = scrollBodyRef.current;
    const obs = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: '200px',
      },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, loadMore, loading, albums.length, scrollBodyEl, useLocalIndex]);

  const handleEnqueueSelected = async () => {
    if (selectedAlbums.length === 0) return;
    try {
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

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      {!perfFlags.disableMainstageStickyHeader && (
        <div className="mainstage-inpage-toolbar">
          <div className="page-sticky-header mainstage-inpage-toolbar-row">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 0 }}>
              <h1 className="page-title" style={{ marginBottom: 0 }}>
                {selectionMode && selectedIds.size > 0
                  ? t('albums.selectionCount', { count: selectedIds.size })
                  : t('home.losslessAlbums')}
              </h1>
              {!(selectionMode && selectedIds.size > 0) && useLocalIndex === false && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.3 }}>
                  {t('losslessAlbums.slowFetchHint')}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {selectionMode && selectedIds.size > 0 && (
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
        viewportId={LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindLosslessScrollBody}
        railInset="panel"
        measureDeps={[
          unsupported,
          loading,
          albums.length,
          hasMore,
          selectionMode,
          useLocalIndex,
          perfFlags.disableMainstageVirtualLists,
          perfFlags.disableMainstageStickyHeader,
        ]}
      >
        {unsupported ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            {t('losslessAlbums.unsupported')}
          </div>
        ) : loading && albums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : albums.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            {t('losslessAlbums.empty')}
          </div>
        ) : (
          <>
            <VirtualCardGrid
              items={albums}
              itemKey={(a, _i) => a.id}
              rowVariant="album"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={albums.length}
              scrollRootId={LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
              warmGridCovers={albumGridWarmCovers()}
              renderItem={a => (
                <AlbumCard
                  album={a}
                  linkQuery={LOSSLESS_MODE_QUERY}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(a.id)}
                  onToggleSelect={toggleSelect}
                  selectedAlbums={selectedAlbums}
                />
              )}
            />
            <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
              {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
            </div>
          </>
        )}
      </OverlayScrollArea>
    </div>
  );
}
