import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { resolveAlbum } from '../utils/offline/offlineMediaResolve';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useInpageScrollSentinel } from '../hooks/useInpageScrollSentinel';
import { useInpageScrollViewport } from '../hooks/useInpageScrollViewport';
import InpageScrollSentinel from '../components/InpageScrollSentinel';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import SortDropdown from '../components/SortDropdown';
import { albumArtistDisplayName } from '../utils/album/deriveAlbumHeaderArtistRefs';
import {
  albumBrowseSortForServer,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';
import {
  runLocalAlbumBrowsePage,
  sortSubsonicAlbums,
  type AlbumBrowseSort,
} from '../utils/library/browseTextSearch';

/** Local index page size — SQLite is cheap; larger pages than the network walk. */
const LOCAL_PAGE_SIZE = 30;

/** Per-loadMore budget for the Navidrome bit_depth song-stream fallback. */
const NETWORK_TARGET_ALBUMS = 12;
const NETWORK_SONGS_PER_FETCH = 100;
const NETWORK_MAX_FETCHES_PER_LOAD = 2;

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for safe download filenames
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

export default function LosslessAlbums() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const auth = useAuthStore();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const sort = useAlbumBrowseSessionStore(s => albumBrowseSortForServer(s.sortByServer, serverId));
  const setBrowseSort = useAlbumBrowseSessionStore(s => s.setSort);
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

  const displayAlbums = useMemo(() => {
    if (useLocalIndex === false) return sortSubsonicAlbums(albums, sort);
    return albums;
  }, [albums, sort, useLocalIndex]);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(displayAlbums);
  const selectedAlbums = displayAlbums.filter(a => selectedIds.has(a.id));

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };

  /** Network pagination cursor — unused on the local path. */
  const songCursor = useRef(0);
  const seenIds = useRef<Set<string>>(new Set());
  const localOffset = useRef(0);
  const inFlight = useRef(false);
  const {
    scrollBodyEl,
    bindScrollBody: bindLosslessScrollBody,
    getScrollRoot,
  } = useInpageScrollViewport();

  const sortOptions: { value: AlbumBrowseSort; label: string }[] = [
    { value: 'alphabeticalByName', label: t('albums.sortByName') },
    { value: 'alphabeticalByArtist', label: t('albums.sortByArtist') },
  ];

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    unsupported,
    selectionMode,
    activeServerId,
    sort,
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
    const data = await runLocalAlbumBrowsePage(
      serverId,
      sort,
      localOffset.current,
      LOCAL_PAGE_SIZE,
      undefined,
      true,
    );
    if (data == null) return null;
    localOffset.current += data.length;
    return { albums: data, hasMore: data.length === LOCAL_PAGE_SIZE };
  }, [serverId, sort]);

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
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlbums([]);
    setHasMore(true);
    setUnsupported(false);
    setUseLocalIndex(null);
    setLoading(true);

    (async () => {
      inFlight.current = true;
      try {
        if (indexEnabled && serverId) {
          const data = await runLocalAlbumBrowsePage(
            serverId,
            sort,
            0,
            LOCAL_PAGE_SIZE,
            undefined,
            true,
          );
          if (cancelled) return;
          if (data != null) {
            setUseLocalIndex(true);
            localOffset.current = data.length;
            setAlbums(data);
            setHasMore(data.length === LOCAL_PAGE_SIZE);
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
  }, [activeServerId, indexEnabled, loadMoreNetwork, serverId, sort]);

  const bindLoadMoreSentinel = useInpageScrollSentinel({
    active: hasMore && useLocalIndex !== null,
    getScrollRoot,
    scrollRootEl: scrollBodyEl,
    onIntersect: () => { void loadMore(); },
    rootMargin: '200px',
  });

  const handleEnqueueSelected = async () => {
    if (selectedAlbums.length === 0) return;
    try {
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
              {!(selectionMode && selectedIds.size > 0) && (
                <SortDropdown
                  value={sort}
                  options={sortOptions}
                  onChange={value => setBrowseSort(serverId, value)}
                />
              )}
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
                style={selectionMode ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}}
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
        ) : loading && displayAlbums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : displayAlbums.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            {t('losslessAlbums.empty')}
          </div>
        ) : (
          <>
            <VirtualCardGrid
              items={displayAlbums}
              itemKey={(a, _i) => a.id}
              rowVariant="album"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={displayAlbums.length}
              scrollRootId={LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
              warmGridCovers={albumGridWarmCovers()}
              renderItem={a => (
                <AlbumCard
                  album={a}
                  observeScrollRootId={LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                  linkQuery={LOSSLESS_MODE_QUERY}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(a.id)}
                  onToggleSelect={toggleSelect}
                  selectedAlbums={selectedAlbums}
                />
              )}
            />
            {hasMore && useLocalIndex !== null && (
              <InpageScrollSentinel bindSentinel={bindLoadMoreSentinel} loading={loading} />
            )}
          </>
        )}
      </OverlayScrollArea>
    </div>
  );
}
